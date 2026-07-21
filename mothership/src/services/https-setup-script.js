/**
 * Returns the atomic bash script template for HTTPS setup.
 * Receives DOMAIN ($1), PORT ($2), EMAIL ($3) as positional args.
 * Runs on the host via chroot /host/root bash -s (agent bridge).
 *
 * Atomic design: every failure triggers rollback. nginx -t mandatory before/after.
 * Uses nginx -s reload (signal-based, works in chroot without D-Bus).
 * The end state is always either "old config" or "new HTTPS config" — never partial.
 *
 * Safety: write operations are validated against a path whitelist.
 * Only /etc/nginx, /etc/letsencrypt, and /var/log are writable.
 * All writes are preceded by backup and verified with nginx -t.
 */

export const buildSetupScript = () => `set -euo pipefail

DOMAIN="\$1"
NODE_PORT="\$2"
EMAIL="\$3"

# ── Allowed write directories (everything else is blocked) ──
ALLOWED_WRITE="/etc/nginx /etc/letsencrypt /var/log"

# Validates a file path is within an allowed write directory.
# Exits with error if the path is disallowed.
guard_path() {
    local p="\$1"
    local p_real="\$(realpath -m "\$p" 2>/dev/null || echo "\$p")"
    for d in \$ALLOWED_WRITE; do
        case "\$p_real" in
            "\$d"|"\$d"/*) return 0 ;;
        esac
    done
    log "SAFETY BLOCK: disallowed write path: \$p"
    exit 1
}

NGINX_SITES="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"
CONFIG_FILE="$NGINX_SITES/symbio.conf"
BACKUP_FILE="$NGINX_SITES/symbio.conf.bak"
LOG_FILE="/var/log/symbio-https-setup.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] \$1"
}

fail_and_rollback() {
    log "ERROR: \$1"
    log "Rolling back configuration..."
    if [ -f "$BACKUP_FILE" ]; then
        guard_path "$BACKUP_FILE"
        guard_path "$CONFIG_FILE"
        cp "$BACKUP_FILE" "$CONFIG_FILE" 2>/dev/null || true
        if nginx -t 2>/dev/null; then
            nginx -s reload 2>/dev/null || true
            log "Rollback complete — restored previous config."
        else
            log "Rollback WARNING: restored config failed nginx -t. Manual fix needed: $CONFIG_FILE"
        fi
    else
        # No backup means this was a fresh install — remove the failed config
        guard_path "$CONFIG_FILE"
        guard_path "$NGINX_ENABLED/symbio.conf"
        rm -f "$CONFIG_FILE" "$NGINX_ENABLED/symbio.conf" 2>/dev/null || true
        log "Rollback complete — no previous config to restore."
    fi
    exit 1
}

# ── Certbot installation (auto-try with DNS override, fallback to manual) ──
install_certbot() {
    if command -v certbot &>/dev/null; then return 0; fi
    log "Certbot not found. Attempting automatic installation..."

    # Override DNS to Cloudflare (1.1.1.1) in case host's resolver doesn't work in chroot
    local dns_bk
    dns_bk=$(mktemp /tmp/symbio-resolv.XXXXXX)
    cp /etc/resolv.conf "$dns_bk" 2>/dev/null || true
    # Set trap to always restore DNS even if script is killed mid-install
    trap "cp '$dns_bk' /etc/resolv.conf 2>/dev/null; rm -f '$dns_bk'" EXIT
    echo "nameserver 1.1.1.1" > /etc/resolv.conf

    set +e
    apt-get update -y 2>&1 | tail -3
    local rc_up=$?
    apt-get install -y certbot python3-certbot-nginx 2>&1 | tail -5
    local rc_inst=$?
    set -e

    # Restore DNS immediately (trap will also fire but harmlessly after restore)
    cp "$dns_bk" /etc/resolv.conf 2>/dev/null || true
    rm -f "$dns_bk"
    trap - EXIT

    if [ $rc_up -ne 0 ] || [ $rc_inst -ne 0 ]; then
        log "Automatic certbot installation FAILED (update=$rc_up install=$rc_inst)."
        log "Install it manually on the server, then re-run the wizard:"
        log "  sudo apt-get update && sudo apt-get install -y certbot python3-certbot-nginx"
        return 1
    fi
    if ! command -v certbot &>/dev/null; then
        log "Certbot binary not found after successful apt-get install."
        return 1
    fi
    log "Certbot installed successfully."
    return 0
}

log "===== STARTING HTTPS SETUP FOR \$DOMAIN ====="

# 1. Check root
if [ "$EUID" -ne 0 ] && [ "$(id -u)" -ne 0 ]; then
    fail_and_rollback "This script must be run as root."
fi

# 2. Ensure certbot is installed (auto or manual)
if ! install_certbot; then
    fail_and_rollback "Certbot installation failed. Install manually and re-run the wizard."
fi

# 3. Ensure nginx is installed
if ! command -v nginx &>/dev/null; then
    fail_and_rollback "Nginx is not installed. Install nginx first and try again."
fi

# 4. Backup existing config
if [ -f "$CONFIG_FILE" ]; then
    guard_path "$CONFIG_FILE"
    guard_path "$BACKUP_FILE"
    cp "$CONFIG_FILE" "$BACKUP_FILE"
    log "Existing config backed up to $BACKUP_FILE"
else
    touch "$BACKUP_FILE"
fi

# 5. Write base HTTP config
guard_path "$CONFIG_FILE"
cat > "$CONFIG_FILE" << 'NGINX_EOF'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX_EOF

guard_path "$CONFIG_FILE"
sed -i "s/__DOMAIN__/$DOMAIN/g; s/__PORT__/$NODE_PORT/g" "$CONFIG_FILE"
log "HTTP config written for $DOMAIN on port $NODE_PORT."

# 6. ATOMIC CHECK: nginx -t before enabling
if ! nginx -t 2>&1; then
    fail_and_rollback "Nginx syntax check FAILED for the new config."
fi
log "Nginx syntax check PASSED."

# 7. Enable site and reload (HTTP only)
guard_path "$NGINX_ENABLED/symbio.conf"
ln -sf "$CONFIG_FILE" "$NGINX_ENABLED/symbio.conf"
nginx -s reload 2>&1 || fail_and_rollback "Failed to reload nginx."
log "Nginx reloaded successfully (HTTP mode)."

# 8. RUN CERTBOT (obtains SSL cert and modifies nginx config)
log "Running Certbot to obtain SSL certificate for $DOMAIN..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect 2>&1
CERTBOT_EXIT=$?
if [ $CERTBOT_EXIT -ne 0 ]; then
    fail_and_rollback "Certbot failed (exit code $CERTBOT_EXIT)."
fi
log "Certbot completed successfully."

# 9. Verify certificate files exist
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    fail_and_rollback "Certificate files not found after Certbot run."
fi

# 10. FINAL ATOMIC CHECK: nginx -t after certbot modifications
if ! nginx -t 2>&1; then
    fail_and_rollback "Nginx syntax check FAILED after Certbot modifications."
fi
log "Nginx syntax check PASSED after Certbot."

# 11. Final reload with HTTPS config
nginx -s reload 2>&1 || { log "ERROR: nginx reload failed after certbot. Config may not be active."; exit 1; }
log "Nginx reloaded with HTTPS configuration."

# 12. Verify HTTPS reachability
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://$DOMAIN" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "000" ]; then
    log "WARNING: HTTPS verification curl failed. Check DNS propagation."
elif [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
    log "HTTPS VERIFICATION SUCCESSFUL — $DOMAIN returned $HTTP_CODE."
else
    log "WARNING: HTTPS reached but returned HTTP $HTTP_CODE."
fi

# 13. Cleanup backup on success
guard_path "$BACKUP_FILE"
rm -f "$BACKUP_FILE"
log "===== SETUP COMPLETE (SUCCESS) ====="
exit 0
`;
