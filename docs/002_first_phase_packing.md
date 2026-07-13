# Symbio Phase 1 Packaging Notes

> This file is retained as the earlier packaging workstream note. The canonical
> Phase 1.5 requirements draft is
> [`003_first_and_half_phase.md`](003_first_and_half_phase.md).

## Status

Planning draft for work after Phase 1 monitoring is stable. This document is intentionally not an implementation claim.

## 1. Objective

Convert the source-built Beta into a versioned, verifiable, maintainable release and add the smallest safe log-viewing capability. A noob operator should be able to install, update, roll back, back up, restore, and remove Symbio without editing Compose files or risking unrelated server data.

## 2. Release Artifacts

- Replace installation from `main` with immutable release tags.
- Publish versioned amd64 and arm64 mothership/agent images.
- Pin images by release version and record their digests.
- Publish SHA-256 checksums for installer and release files.
- Produce software bills of materials for both images.
- Record Git commit, build time, Node version, dependency lock hash, architecture, and image digest.
- Keep source releases available for audit and reproducible-build investigation.
- Installer must reject an unsupported or malformed version before changing the host.

## 3. Installation and Lifecycle Commands

Design one stable command entrypoint with subcommands:

- `install`
- `status`
- `update [version]`
- `rollback`
- `backup [destination]`
- `restore <backup>`
- `uninstall`

The public one-line command downloads and verifies a small bootstrap script. It must not silently select `main`.

### Installation

- Preflight supported Ubuntu/architecture, Docker/Compose, disk space, ports, DNS-independent local connectivity, and existing resources.
- Download versioned Compose/configuration files into a staging directory.
- Pull pinned images instead of building on the monitored host.
- Verify checksums/digests before running images.
- Run migrations and interactive superadmin creation.
- Health-check both services before committing the install directory.
- Write structured and human-readable diagnostics without secrets.

### Update

1. Resolve and validate the requested target version.
2. Refuse downgrades unless explicitly using rollback.
3. Back up mothership SQLite, agent SQLite, Compose settings, and non-secret metadata.
4. Pull and verify new artifacts before stopping the current release.
5. Run documented backward-compatible migrations.
6. Start the new release and wait for agent/mothership health and one accepted report.
7. Commit the new version only after validation.
8. On failure, restore previous artifacts and database backup automatically.

Migrations must document whether rollback is possible. A release with an irreversible migration requires an explicit operator confirmation and a verified backup.

### Rollback

- Retain at least the immediately previous verified release metadata.
- Restore the corresponding database/configuration backup.
- Restart the previous image digests.
- Validate login, agent report acceptance, and database migration version.
- Never roll back unrelated Docker resources.

### Backup and restore

- Use SQLite's safe backup mechanism rather than copying a live database file blindly.
- Include database, settings, release metadata, and encrypted/shared credentials with strict filesystem permissions.
- Exclude monitoring history optionally for smaller configuration-only backups.
- Store a manifest with schema version and checksums.
- Restore only into a compatible Symbio version and an empty/stopped target.
- Validate manifest checksums before replacement.

### Uninstall

- Stop and remove only Symbio containers and networks.
- Ask separately whether to retain or remove data volumes, configuration, backups, images, and source files.
- Default to preserving data.
- Print exact retained paths/resources.

## 4. Installer Reliability

- Use a transaction-style staging directory and cleanup trap.
- Preserve the last working install until replacement passes health checks.
- Use bounded network timeouts and actionable offline errors.
- Detect port conflicts and allow explicit public/internal/agent port selection.
- Never query a third-party IP-discovery service automatically.
- Redact tokens, passwords, cookies, environment secrets, and command input.
- Add stable machine-readable error codes alongside human messages.
- Support a dry-run/preflight mode that performs no mutations.
- Provide a diagnostic bundle command that excludes secrets and monitored application data.

## 5. Bounded Read-Only Log Viewer

### Scope

- Superadmin registers a friendly log name and an absolute path on the same Main Server.
- Log source must be beneath an installer-approved read-only host directory.
- Store a configurable tail length from 10 to 10,000 lines, default 1,000.
- Enforce a maximum returned byte count independent of line count.
- Viewer displays path, configured tail size, file modification time, truncation notice, and read error.
- Manual refresh works without JavaScript.
- Optional plain-JavaScript polling defaults off and uses a minimum three-second interval.
- Textarea/preformatted output prioritizes performance and preserves raw line breaks.

### Security model

- Add only explicit read-only log-directory mounts; do not expose arbitrary host root paths through the web API.
- Resolve canonical paths and reject traversal, symlink escape, device files, sockets, and directories.
- Open files read-only and never pass user values to a shell.
- Limit concurrent reads and request frequency.
- Do not persist log contents in Symbio SQLite.
- Escape log output as text, never HTML.
- Record administrative registration/change events without recording log contents.

### Explicitly excluded

- Clear or truncate.
- Full-file search.
- Download entire file.
- Docker logs.
- PM2 logs or RPC.
- SSH/remote logs.
- Glob patterns or arbitrary path browsing.
- Log ingestion, indexing, aggregation, alerts, or metrics.

## 6. Proposed Log Data Model

`logs`

- `id`
- non-null `server_id`
- permanent unique `name`
- editable `display_name`
- `file_path`
- `tail_lines`
- `max_bytes`
- `polling_enabled`
- entity timestamps and optional `deleted_at`

Do not create a log-content/history table.

## 7. Acceptance Tests

### Packaging

- Fresh pinned install on supported Ubuntu amd64 and arm64.
- Invalid checksum/digest stops before containers start.
- Upgrade from the previous release preserves login, configuration, and history.
- Simulated failed migration/startup returns to the previous healthy release.
- Uninstall preserves data by default and removes only selected Symbio resources.
- Backup/restore reproduces configuration and passes manifest validation.
- Offline, disk-full, occupied-port, and interrupted-download failures are actionable and rollback cleanly.

### Log viewer

- Valid approved files return only the configured bounded tail.
- Large lines/files cannot exceed the byte cap.
- Missing/unreadable/rotated files produce clear non-sensitive errors.
- Traversal, symlink escape, device, socket, and unmounted paths are rejected.
- HTML/script text is displayed literally.
- Manual refresh works without JavaScript; polling stops when the page is hidden or unloaded.
- No route can modify or download the full log file.

## 8. Deferred After Phase 1.5

- Automated HTTPS and certificate lifecycle.
- Multiple servers and remote agents.
- Additional users, groups, and permissions.
- Docker/PM2 inspection.
- Remote/SSH logs.
- Search, aggregation, alerting, notifications, or incident diagnosis.
- Commands, service restarts, repairs, code/config edits, and other mutations.
