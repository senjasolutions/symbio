# Symbio Functional Requirements

## 1. Product Definition

Symbio is a lightweight, self-hosted monitoring and small-server management toolkit for Linux servers. Its first release monitors the same Ubuntu server on which Symbio runs. It is intended for operators who need clear operational information without learning a large monitoring platform.

Symbio prioritizes, in order:

1. Correct and truthful behavior.
2. Reliability and recoverability.
3. Familiar server-management UX.
4. Low host resource use.
5. Visual polish.

The browser interface is server-rendered. JavaScript may progressively refresh current values, but authentication, navigation, configuration, and history remain usable without JavaScript.

## 2. Documentation Map

- [`docs/001_first_phase.md`](docs/001_first_phase.md): implemented single-server monitoring Beta.
- [`docs/002_first_phase_packing.md`](docs/002_first_phase_packing.md): supporting Phase 1 packaging notes.
- [`docs/003_first_and_half_phase.md`](docs/003_first_and_half_phase.md): canonical Phase 1.5 packaging, lifecycle, recovery, and bounded-log draft.
- `docs/old_code_ref`: obsolete proof-of-concept retained only for historical reference.

Phase documents are the implementation-level source of truth. This document records product-wide rules and the phase roadmap.

## 3. Product-Wide Requirements

### FR-GEN-01 — Truthful evidence

- Symbio must distinguish process detection, protocol response, HTTP response, and agent heartbeat.
- A detected process must not be labelled healthy unless a deeper probe succeeds.
- Missing or stale evidence must become `unknown`, `stale`, or `offline`, not a fabricated positive or negative status.

### FR-GEN-02 — Server-rendered interface

- Pages use Hono, Mustache, locally bundled Bootstrap, and plain JavaScript.
- No SPA framework or TypeScript is permitted.
- Status must never be communicated by color alone.
- Navigation and controls use a clean-room visual system heavily inspired by
  familiar cPanel/WHM-style server tools: grouped dark administrative navigation,
  a compact server/user header, breadcrumb-led pages, dense tables, and clear
  panel/form action bars. Symbio does not reuse cPanel/WHM source, assets,
  logos, or implementation code.

### FR-GEN-03 — Lightweight operation

- The Phase 1 acceptance host is 1 vCPU and 1 GB RAM.
- Combined steady-state Symbio RSS target is below 200 MB.
- Average idle CPU target is below 1% over five minutes.
- Representative server-rendered pages should respond within one second.

### FR-GEN-04 — Security boundary

- Containers run as non-root with dropped Linux capabilities and read-only root filesystems.
- The monitoring agent receives only required read-only host mounts.
- The Docker socket is not mounted in Phase 1.
- The agent may receive a fixed read-only host-root bind only for storage and
  network inventory; it never provides arbitrary host-path or file-browser access.
- For registered ordinary application logs, the non-root agent may receive the
  host `adm` GID as a supplementary group. This permits only files already
  group-readable by that host group; it does not grant root, write, or path access.
- The system D-Bus socket is not mounted, so process/protocol/HTTP evidence is
  retained instead of claiming live `systemctl` unit state.
- Agent-to-mothership traffic uses a generated shared bearer token on a host-loopback endpoint.
- Public HTTP is an explicitly insecure Beta mode. Symbio must not claim production-safe public access until HTTPS is implemented or supplied by a trusted reverse proxy.

### FR-GEN-05 — Documentation discipline

- Feature changes update the applicable phase document and this FRD when project-wide behavior changes.
- New or changed files and non-obvious functions/logic include concise comments explaining purpose and design reason.
- Historical prototype behavior must not be described as current behavior.

## 4. Phase Roadmap

### Phase 1 — Monitoring Beta

- One Ubuntu server.
- Mothership and agent containers.
- Superadmin authentication.
- Host metrics including logical CPU, memory/swap, usable storage, and network inventory; seven fixed service adapters.
- HTTP application monitoring.
- Seven-day history, recent tables, and simple charts.
- Locally bundled Tagify with no-JavaScript tag fallback, Installation Status, settings placeholder, registered read-only application log viewing, read-only file manager with directory tree and file preview, and per-application source directory shortcuts.
- On-demand system inspection: server information, process list, listening ports, memory detail, logged-in users, installed packages, and disk I/O.
- Read-only file viewer with line numbers, 100 KB cap, null-byte binary detection, and multi-layer path whitelist/blocklist security.
- Source-build installer from `main` while the project remains Beta.

### Phase 1.5 — Packaging and bounded logs

- Pinned releases and versioned images.
- Safe update, rollback, uninstall, backup, and restore.
- Release integrity metadata and multi-architecture artifacts.
- Bounded read-only host-file log tailing.

### Later phases

- HTTPS automation.
- Multiple servers and per-agent credentials.
- Admin and regular-user roles with permissions.
- Dark mode and additional languages.
- Docker/PM2 inspection beyond Phase 1 evidence.
- Notifications, incident diagnosis, safe commands, repairs, and policy-gated mutations.

## 5. Explicit Global Non-Goals for Phase 1

- Repository, Docker-container, or source-code inspection. Registered ordinary application log files and read-only file browsing are the bounded exception.
- Arbitrary shell execution or file mutation.
- Service restart or host mutation.
- Database credentials or authenticated service queries.
- Multi-server registration.
- LLM calls, AI diagnosis, or repair proposals.
- Automated HTTPS or firewall modification.
- PostgreSQL as Symbio's own storage backend.

## 6. Current Technology Decisions

- Runtime: Node.js 24 LTS, plain JavaScript ESM.
- HTTP: Hono and `@hono/node-server`.
- Views: Mustache and locally served Bootstrap.
- Persistence: Sequelize 6 with explicit SQLite migrations.
- Password storage: Argon2id.
- Deployment: Docker Compose on Ubuntu 22.04, 24.04, or 26.04 LTS, amd64 or arm64.

Sequelize is an application boundary for a later PostgreSQL adapter. PostgreSQL portability is not automatic: later work still requires PostgreSQL migrations and contract tests.
