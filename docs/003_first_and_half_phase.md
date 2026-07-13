# Symbio Phase 1.5 Draft — Release Packaging and Bounded Logs

> Planning status: draft. This document defines the proposed work after the
> Phase 1 monitoring Beta. It does not describe features available today.

## 1. Purpose

Phase 1 proves that the single-server mothership and agent can monitor a host.
Phase 1.5 makes that software safe to distribute, update, recover, and remove
without losing operator-owned state. It also adds one deliberately narrow
read-only log viewer for registered host files.

The release remains single-server and superadmin-only. This phase does not add
remote commands, service control, or arbitrary host access.

## 2. Outcomes

Phase 1.5 is complete only when an operator can:

1. Install a named Symbio release whose source and images are verifiable.
2. Update from the immediately previous supported release without losing data.
3. Roll back automatically when an update fails its health checks.
4. Back up and restore the complete persistent state with documented commands.
5. Uninstall application resources while choosing whether to retain data.
6. Read a bounded tail of an explicitly registered host log file without
   gaining file browsing, mutation, or command execution.

## 3. Release Artifacts and Integrity

### FR-1.5-REL-01 — Pinned releases

- The installer must require a stable release tag such as `v0.2.0`.
- Installation from a moving branch such as `main` must no longer be the normal
  installation path.
- Mothership and agent images must use the same Symbio version.
- Compose configuration must pin images by immutable digest for an installed
  release. A mutable tag alone is insufficient.
- The installed version and release metadata must be visible in the dashboard
  and through a local diagnostic command.

### FR-1.5-REL-02 — Verifiable artifacts

Each release must publish:

- Installer and release-manifest SHA-256 checksums.
- amd64 and arm64 mothership image digests.
- amd64 and arm64 agent image digests.
- A software bill of materials for each image.
- Source revision, build timestamp, runtime version, and build-platform
  metadata sufficient to diagnose an artifact.

Checksum or digest mismatches must stop installation or update before any
running installation is changed.

### FR-1.5-REL-03 — Reproducible build metadata

- Dependency lockfiles remain mandatory.
- Release builds must use a documented Node.js and base-image version.
- Build metadata must identify inputs even if byte-for-byte reproducibility is
  not yet achieved.
- CI must fail when an artifact is missing its checksum, digest, SBOM, or
  supported-architecture variant.

## 4. Installation and Lifecycle Commands

### FR-1.5-LIFE-01 — Command surface

The installed management command should expose these explicit operations:

```text
symbio version
symbio status
symbio update [version]
symbio rollback
symbio backup [destination]
symbio restore <backup>
symbio uninstall [--keep-data]
```

The final spelling may change during design, but scripts must share one common
implementation rather than duplicating lifecycle logic.

### FR-1.5-LIFE-02 — Safe updates

An update must follow this order:

1. Validate prerequisites, requested version, free disk space, and ports.
2. Download and verify the release manifest and all selected artifacts.
3. Record the current version, image digests, configuration, and volume names.
4. Create and verify a pre-update backup.
5. Check that every pending migration is supported by the target release.
6. Pull or load the pinned target images.
7. Run backward-compatible database migrations.
8. Start the target containers and wait for both health checks.
9. Verify login-page availability and one authenticated internal agent report.
10. Mark the target release active only after every check passes.

The update must preserve `/etc/symbio`, internal credentials, mothership data,
agent outbox data, and operator settings.

### FR-1.5-LIFE-03 — Health-checked rollback

- A failed update must restore the saved Compose/release metadata and database
  backup, then restart the last known-good images.
- Rollback must also be available as an explicit operator command for the most
  recent update.
- If both update and rollback fail, Symbio must stop and print exact recovery
  paths. It must not delete the backup or pretend that service is healthy.
- Release notes must identify migrations that prevent rollback. Phase 1.5
  should avoid such migrations; destructive schema removal is prohibited.

### FR-1.5-LIFE-04 — Uninstall

- Default uninstall removes containers, images created only for Symbio,
  command wrappers, and installation source.
- Default uninstall must require explicit confirmation before deleting data.
- `--keep-data` retains databases, configuration, credentials, and backups and
  prints their locations.
- Full data deletion requires a separate explicit confirmation naming the data
  paths that will be removed.
- Uninstall must not remove Docker itself or unrelated images, networks,
  volumes, reverse-proxy configuration, or firewall rules.

## 5. Backup and SQLite Restore

### FR-1.5-DATA-01 — Consistent backups

- A backup must include both SQLite databases, deployment configuration,
  release metadata, and the agent credential.
- SQLite backup must use the SQLite backup API or a verified equivalent; a raw
  copy of a live database is not accepted.
- The resulting archive must include a manifest, format version, checksums, and
  the originating Symbio version.
- Backup archives contain credentials and must be created with owner-only
  permissions.
- Backup must fail clearly when the destination lacks space or is not writable.

### FR-1.5-DATA-02 — Restore

- Restore must stop both containers before replacing persistent state.
- It must validate the archive format, every checksum, and version
  compatibility before changing current data.
- Current state must be backed up before restore so a failed restore can be
  reversed.
- After restore, migrations run only when the target version supports the
  backup's schema version.
- Both containers and an agent report must pass health verification before the
  restore is declared successful.

## 6. Installer Improvements

### FR-1.5-INST-01 — Diagnostics

- Validate operating system, architecture, root access, Docker daemon,
  Compose version, required commands, disk space, DNS, release endpoint access,
  registry access, and port availability before mutation.
- Offline, DNS, TLS, rate-limit, checksum, registry, and disk-space failures
  must produce distinct messages with the failed endpoint or resource.
- Secret values must never appear in terminal output or logs.

### FR-1.5-INST-02 — Port selection

- Keep `8765`, `18766`, and `18767` as defaults when available.
- An occupied public port must result in a clear prompt or documented override;
  the installer must not silently select an unpredictable port.
- Internal ports must remain bound to loopback.
- The final selected URLs and configuration paths must be printed after a
  successful installation.

### FR-1.5-INST-03 — Structured logs

- Lifecycle operations must write timestamped, levelled records with an
  operation ID and step name.
- Logs must be useful for support without containing passwords, tokens,
  cookies, full backup contents, or other secrets.
- Human terminal output may remain concise while pointing to the detailed log.
- Failed operations must preserve the log and backup paths needed for recovery.

## 7. Bounded Read-Only Log Viewer

### FR-1.5-LOG-01 — Registration model

- A superadmin registers a display name and one absolute host file path beneath an application.
- Paths are stored in mothership configuration and read only by the host-aware agent through its fixed read-only host-root bind; mothership never receives a host filesystem mount.
- The agent remains non-root. On Ubuntu it receives the host `adm` numeric GID
  as a supplementary group so ordinary `0640 root/www-data:adm` web-server logs
  can be read without granting root or write access.
- Only registered paths may be read. The request API must use a log-source ID,
  never an arbitrary user-supplied path.
- Symlinks and path traversal must be rejected after canonical-path
  resolution.
- Missing, rotated, unreadable, or non-regular files must show a truthful error.

Adding a new path may require a controlled Compose configuration change and
agent restart. Phase 1.5 must not broaden this into a general host filesystem
browser.

### FR-1.5-LOG-02 — Bounded tailing

- The default tail is 200 lines; allowed values are 50, 100, 200, 500, and 1,000.
- The operator may select only predefined bounded values, with a maximum of
  1,000 lines.
- A response must also enforce a byte limit; line count alone is insufficient.
- The response limit is 512 KiB and individual lines are truncated at 8 KiB with a visible marker.
- Output is treated as untrusted plain text and escaped by the server-rendered
  view.
- Extremely long individual lines must be truncated with a visible marker.
- The viewer must not load an entire large file into memory to find its tail.

### FR-1.5-LOG-03 — Refresh behavior

- Manual refresh is always available and works without JavaScript.
- Optional polling may progressively refresh the current tail.
- Polling must have a conservative minimum interval, stop on a hidden page, and
  avoid overlapping requests.
- The page shows source name, registered path, last-read time, selected limit,
  bytes returned, and truncation/error state.

### FR-1.5-LOG-04 — Explicit exclusions

The Phase 1.5 viewer must not provide:

- Clear, truncate, edit, delete, rotate, or download-all actions.
- Regular expressions or cross-file queries. A case-sensitive literal search is allowed only within the newest 8 MiB of one registered application log, returns at most five matches with ten lines of context, and enforces the normal output bound.
- Docker logs or Docker socket access.
- PM2 logs or PM2 command access.
- SSH, terminal, shell, or arbitrary command execution.
- Directory browsing, globbing, or arbitrary paths.
- Automatic secret detection claims.

## 8. Security and Reliability Rules

- Lifecycle commands require root because they manage Docker and protected
  paths; the web application and containers remain non-root.
- Web requests never invoke lifecycle commands.
- Backups, manifests, and logs use restrictive permissions.
- Existing CSRF, session, throttling, secure-header, no-Docker-socket, dropped
  capability, and read-only filesystem requirements remain in force.
- Public HTTP remains insecure Beta behavior. HTTPS automation is not added in
  this phase, and production-safe public deployment must not be claimed.
- Every failure message must distinguish `not attempted`, `failed`, and
  `rolled back`; these states must not be collapsed into `success`.

## 9. Packaging Acceptance Tests

Release automation must test all of the following:

1. Fresh installation from a pinned release on supported Ubuntu amd64.
2. Fresh installation from the same release on supported Ubuntu arm64.
3. Upgrade from the immediately previous supported release with configuration,
   users, monitoring history, applications, tags, and agent outbox preserved.
4. Failed image health check followed by automatic rollback to working service.
5. Failed migration followed by verified database and image rollback.
6. Uninstall with data retention followed by successful reinstall and reuse.
7. Full uninstall that removes only the explicitly confirmed Symbio resources.
8. Backup creation while monitoring data is being written.
9. Restore into a clean compatible installation with checksum and health
   verification.
10. Rejection of a corrupt backup, checksum mismatch, wrong architecture, and
    incompatible schema version without changing current state.
11. Published amd64/arm64 image manifests, digests, checksums, SBOMs, and build
    metadata are present and internally consistent.
12. Log viewer rejects arbitrary paths, traversal, symlinks, oversized output,
    non-regular files, and mutation attempts.

## 10. Deferred Beyond Phase 1.5

The following remain explicitly out of scope:

- Automated HTTPS certificates or reverse-proxy management.
- Multi-server registration or remote agents.
- Additional roles and permissions.
- Docker container inspection or Docker socket access.
- PM2 application inspection or control.
- Docker logs, PM2 logs, arbitrary/full-file log search, or log aggregation.
- Commands, service restarts, repairs, file mutation, or troubleshooting actions.
- Alerts, notifications, AI diagnosis, or LLM integration.

## 11. Open Design Decisions for the Next Planning Pass

These questions must be resolved before implementation begins:

1. Which registry and signing mechanism will publish and attest images?
2. How many previous releases will update and rollback support?
3. Where should default backups live, and what minimum free-space rule applies?
4. Should log-source registration edit Compose mounts automatically through a
   root-only CLI, or require an operator-edited allowlist followed by restart?
5. What exact response byte limit and polling intervals meet the 1 vCPU/1 GB
   performance target?
6. Which Ubuntu LTS versions are actually available and supported when Phase
   1.5 ships? The compatibility matrix must be verified at release time.
