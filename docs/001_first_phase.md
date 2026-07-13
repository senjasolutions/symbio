# Symbio Phase 1 — Single-Server Monitoring Beta

## 1. Objective

Phase 1 delivers a small monitoring dashboard for the same Ubuntu server on which Symbio is installed. A server operator can install two Docker containers, create one superadmin, log in, inspect host/service/application status, and review seven days of bounded history.

Success means the tool installs predictably, reports only evidence it actually collected, survives container restarts, queues reports during a mothership outage, and remains usable without an SPA.

## 2. Locked Scope

### Included

- One real `Main Server` database record.
- `symbio-mothership` and `symbio-agent` containers.
- Interactive superadmin creation during installation.
- Server CPU, RAM, root disk, load, uptime, hostname, IP, OS, and kernel.
- Fixed monitoring for Docker, PM2, MySQL/MariaDB, PostgreSQL, Redis, Nginx, and Apache.
- HTTP/HTTPS application health checks.
- Application CRUD, soft deletion, restore, tags, and tag filters.
- Editable probe configuration for known services.
- Recent status tables and server-rendered charts for 24 hours or seven days.
- General settings page with English as the only language.
- Source-build Beta installer from the `main` branch.

### Excluded

- Service logs, Docker logs, PM2 logs, and arbitrary filesystem logs. Registered read-only application logs are provided as a Phase 1.5 extension.
- Docker container inspection and Docker socket access.
- PM2 RPC/application inspection.
- Authenticated database queries or stored service credentials.
- Multiple servers.
- Admin/user roles other than superadmin.
- Dark mode, alerts, notifications, incident diagnosis, AI, repair actions, commands, or mutations.
- Built-in HTTPS.

## 3. Deployment Architecture

### Mothership

The mothership owns authentication, configuration, current/history queries, HTML rendering, and the authoritative SQLite database.

It listens on:

- Public dashboard port `8080` inside the container, mapped to `0.0.0.0:8765` by default.
- Private agent port `8081` inside the container, mapped only to host loopback at `127.0.0.1:18766`.

### Agent

The agent collects host evidence, performs probes, caches configuration, and posts idempotent reports.

It uses host networking because ordinary services may listen only on host localhost. Its Hono diagnostics bind only to `127.0.0.1:18767` and expose:

- `GET /healthz`
- `GET /api/v1/status`

The agent has no commands or mutation endpoints.

### Container restrictions

- Run as the image's non-root `node` user.
- Drop all Linux capabilities.
- Set `no-new-privileges`.
- Use read-only container root filesystems and bounded `/tmp` tmpfs mounts.
- Give each container only its own writable data volume.
- Agent mounts host `/proc`, `/etc/os-release`, `/etc/hostname`, and host `/`
  read-only. The fixed host-root bind is used only for `statfs` filesystem
  inventory and `/sys/class/net` interface facts; it does not create file
  browsing, arbitrary paths, logs, commands, or mutations.
- Never mount `/var/run/docker.sock`.

The host-root mount can expose readable host data to a compromised agent. Non-root execution, read-only mode, no file-viewing endpoint, and no arbitrary path input reduce but do not eliminate that risk.

## 4. Authentication

### Superadmin

Phase 1 has only `superadmin`. There is no user-management page because there is no second usable role.

The installer runs the seeder through `/dev/tty` and requests:

- Username: 3–64 characters using letters, numbers, `.`, `_`, or `-`.
- Display name: required, maximum 120 characters.
- Unique email.
- Password and confirmation.

Passwords:

- Minimum 8 Unicode characters and maximum 128.
- No arbitrary character-class composition rules.
- Argon2id using at least 19,456 KiB memory, two passes, and parallelism one.
- Never written to environment files, process arguments, logs, or shell history.

### Browser sessions

- Use a 32-byte opaque session token.
- Store only its SHA-256 hash in SQLite.
- Rotate an existing session during login.
- Default absolute lifetime: 12 hours.
- Cookies use `HttpOnly`, `SameSite=Lax`, and path `/`.
- `Secure` is enabled only when `SYMBIO_COOKIE_SECURE=1` behind HTTPS.
- State-changing forms require a per-session synchronizer CSRF token.
- Login errors are generic and failures are throttled by source address.

## 5. Agent Contract

The agent authenticates using a generated 256-bit token mounted through a Compose secret.

### Configuration

`GET /internal/v1/config`

Returns:

- `schemaVersion: 1`
- Configuration version.
- Report, application, service, and config intervals.
- Active application targets.
- Enabled known-service records and validated adapter configuration.

No service credentials are returned because Phase 1 does not store them.

### Report delivery

`POST /internal/v1/reports`

```json
{
  "schemaVersion": 1,
  "agentId": "main-agent",
  "reports": [
    {
      "id": "UUID",
      "observedAt": "ISO-8601",
      "host": {},
      "metrics": {},
      "services": [],
      "applications": []
    }
  ]
}
```

- Maximum 100 reports per request.
- Report ID is the idempotency key.
- A report and its included samples are stored in one transaction.
- Duplicate report IDs are acknowledged without duplicate samples.

### Offline behavior

- Agent caches the last valid configuration.
- Every collected report is inserted into agent SQLite before delivery.
- The oldest 100 rows are retried first.
- Acknowledged rows are deleted.
- The outbox is bounded to 2,880 reports, approximately 24 hours at 30-second intervals.
- The oldest row is dropped when the bound is exceeded.

## 6. Host Monitoring

Default host sample/report interval is 30 seconds.

- CPU is calculated from deltas between consecutive `/proc/stat` samples. The first sample has unknown CPU percentage.
- RAM uses `MemAvailable`, not only `MemFree`.
- Aggregate and every logical CPU use deltas between consecutive `/proc/stat` samples.
- Memory records used, available, and swap usage; RAM uses `MemAvailable`, not only `MemFree`.
- Storage records unique usable local/network filesystems, excluding tmpfs, proc,
  sysfs, cgroups, Snap paths, and duplicate bind mounts.
- Networking records interface state, MAC, MTU, optional link speed, addresses, and RX/TX counters.
- Load averages and uptime use host procfs.
- OS uses host `/etc/os-release`.
- Kernel uses host procfs.
- Hostname uses host `/etc/hostname` with UTS fallback.
- The installer supplies the first locally detected IPv4 for display; no external IP service is contacted.

Server state derives from the last accepted report:

- `online`: younger than 90 seconds.
- `stale`: 90–180 seconds.
- `offline`: older than 180 seconds or never received.

## 7. Known Service Monitoring

Service checks run every 60 seconds. Every result records status, evidence, bounded description, response time when applicable, and observation time.

Allowed statuses:

- `operational`
- `detected`
- `degraded`
- `unavailable`
- `not_detected`
- `unknown`

### Docker

- Evidence: `heartbeat`.
- A currently executing agent cycle proves the Docker-hosted agent is operating.
- Stale/offline server state supersedes old positive evidence.

### PM2

- Evidence: `process`.
- Scan host process identity for PM2.
- Positive result is `detected`, never `operational`, because Phase 1 does not access PM2 RPC state.

### MySQL/MariaDB

- Default `127.0.0.1:3306`, editable.
- Validate the server-first MySQL protocol version handshake.
- No username/password or query.

### PostgreSQL

- Default `127.0.0.1:5432`, editable.
- Send PostgreSQL SSL negotiation bytes and validate `S` or `N` response.
- No failed login and no credentials.

### Redis

- Default `127.0.0.1:6379`, editable.
- Send RESP `PING`.
- `PONG`, `NOAUTH`, or `NOPERM` proves a Redis protocol response.

### Nginx and Apache

- Detect normalized host process names.
- Without a configured URL, report only `detected` or `not_detected`.
- With an HTTP/HTTPS URL, any response below 500 is `operational`, 500–599 is `degraded`, and connection failure is `unavailable` when a process was detected.

Raw process arguments are never persisted or reported.

## 8. Application Monitoring

Applications are generic HTTP targets. PHP, Node.js, WordPress, Docker, and PM2 applications are represented through names/tags; Phase 1 does not use runtime-specific application adapters.

### Configuration

- Permanent internal slug, 3–64 characters.
- Editable display name.
- Non-null Main Server foreign key.
- HTTP/HTTPS URL without embedded credentials.
- Timeout default 5,000 ms, allowed 1,000–30,000 ms.
- Slow threshold default 1,500 ms, allowed 100–29,999 ms.
- Optional JavaScript regular-expression response matcher, maximum 300 characters.

### Result classification

- `up`: final response is 200–399, optional text matches, and response is below slow threshold.
- `slow`: the same success conditions at or above slow threshold.
- `down`: timeout, network/TLS error, too many redirects, unexpected HTTP status, or a missing required regex match.

Checks:

- Run every 60 seconds.
- Follow at most three redirects.
- Inspect at most 64 KiB of response body.
- Do not disable TLS verification.
- Store status code, response time, final URL, bounded failure reason, and timestamp.
- Never store response bodies.

### CRUD and tags

- Create, view, edit, soft-delete, and restore applications.
- Deleted applications leave agent configuration and retain history until normal cleanup.
- Dedicated application-tag CRUD.
- Locally bundled Tagify tag entry on application create/edit, with a
  comma-separated no-JavaScript fallback.
- Tag names are case-insensitive unique and at most 50 characters.
- Maximum ten tags per application.
- Assigned tags cannot be deleted.

## 9. Persistence

Mothership migrations create:

- `schema_migrations`
- `users`, `sessions`
- `servers`, `agents`, `agent_reports`
- `server_statuses`
- `server_services`, `server_service_statuses`
- `applications`, `application_statuses`
- `application_tags`, `application_tag_assignments`
- `settings`

Entity tables use creation/update timestamps where meaningful. Applications additionally use `deleted_at`. Immutable report/status tables use `observed_at` and/or `received_at`; they do not use update or soft-delete timestamps.

SQLite enables foreign keys, WAL, and a 5-second busy timeout. Schema changes use ordered migrations and never `sequelize.sync()`.

History retention is seven days. Daily cleanup deletes status rows before unreferenced report receipts.

## 10. Browser UI

The authenticated interface uses a clean-room, cPanel/WHM-inspired administrative
shell: grouped dark navigation, a compact Main Server/user header, breadcrumb-led
pages, dense operational tables, and clear panel/form action bars. It uses only
Symbio templates and locally bundled dependencies; no cPanel/WHM HTML, CSS,
logos, icons, JavaScript, or other implementation assets are reused.

Authenticated navigation:

- Dashboard
- Servers
- Services
- Applications
- Application Tags
- Installation Status
- Settings

Dashboard shows current server state, two-decimal CPU/RAM/disk percentages with circular meters, rolling 5-minute/30-minute/6-hour CPU and RAM averages, five service summaries, and five application summaries. A small authenticated JSON endpoint progressively refreshes current summary values every 30 seconds. The original SSR values and manual refresh remain functional if JavaScript fails.

Server detail persists CPU architecture/model/logical-core count, per-core CPU, RAM/swap, storage, and networking inventory. Its labelled SVG charts show time and value axes; CPU average is prominent and individual logical CPU lines are muted. Installation Status reports declared paths, bindings, migrations, hardening, health, and last report. It explicitly cannot inspect containers/images because Docker socket access is prohibited, nor systemd unit state because D-Bus is not mounted.

Server, service, and application details show recent rows. Server/application details show accessible server-rendered SVG charts:

- `24h`: five-minute averages.
- `7d`: hourly averages.

The server list contains the Main Server and a disabled `Add Server — Coming Soon` button.

## 11. Beta Installer

Public command during Beta:

```sh
curl -fsSL https://raw.githubusercontent.com/senjasolutions/symbio/main/install.sh | sudo sh
```

Requirements:

- Root execution.
- Ubuntu 22.04, 24.04, or 26.04 LTS.
- amd64 or arm64.
- Git, Docker Engine, and Docker Compose v2 already installed.

Installer behavior:

1. Validate OS, architecture, commands, Docker daemon, Compose, ports, and absence of an existing install.
2. Warn that default public HTTP is unencrypted.
3. Create root-owned `/etc/symbio` with mode `0700` and its agent token with
   mode `0444`. The protected parent prevents host users from traversing to the
   token, while the file mode lets non-root containers read its read-only bind.
4. Shallow-clone `main` into staging and build both images.
5. Move source to `/opt/symbio` and write non-secret `.env` deployment settings.
6. Apply migrations.
7. Run the interactive superadmin seeder through `/dev/tty`.
8. Start both services and wait for both container health checks.
9. Print localhost and locally detected server URLs.
10. Write detailed redacted output to `/var/log/symbio/install.log`.

On failure, remove only resources created by that fresh attempt. The public
installer rejects existing installations because general Beta update behavior
is not implemented. The repository's VM debugging helper may invoke a guarded
copied-source replacement mode that preserves credentials and named volumes;
that helper is not a public update contract.

## 12. Security Warning

The default `0.0.0.0:8765` mapping can be reachable from public networks and uses plaintext HTTP. Password hashing protects the database copy; it does not protect credentials or session cookies in transit.

Phase 1 therefore permits an explicitly insecure Beta deployment but does not classify it as production-safe. Operators should restrict access or provide an HTTPS reverse proxy. Automated HTTPS belongs to a future phase.

## 13. Acceptance Criteria

- Fresh supported Ubuntu installation reaches a healthy login page.
- Superadmin password never appears in install logs or process arguments.
- Agent delivers the first report within 90 seconds.
- Main Server status becomes online from fresh evidence.
- All seven service rows show an accurate evidence type.
- Application CRUD, soft-delete, restore, tags, and filtering work.
- HTTP checks generate correct up/slow/down results.
- 24-hour and seven-day charts agree with recent stored samples.
- Mothership restart preserves all data.
- Mothership outage queues agent reports and replay does not duplicate them.
- No agent endpoint permits arbitrary filesystem reads or commands.
- No container mounts the Docker socket or runs privileged.
- Runtime meets the 1 vCPU/1 GB performance targets after measurement.
