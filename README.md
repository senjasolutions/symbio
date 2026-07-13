# Symbio

Symbio is a lightweight, server-rendered monitoring dashboard for one Ubuntu server. It runs a private host-aware agent beside a public management dashboard and reports host metrics, known-service evidence, and HTTP application health without a SPA or a large monitoring stack.

Current status: Phase 1 Beta.

## What Works

- Superadmin login with Argon2id passwords, hashed sessions, CSRF, and throttling.
- CPU, RAM, root disk, load, uptime, hostname, IP, OS, and kernel monitoring.
- Evidence-aware status for Docker, PM2, MySQL/MariaDB, PostgreSQL, Redis, Nginx, and Apache.
- HTTP application create/edit/delete/restore and up/slow/down checks.
- Application tag CRUD, inline tag creation, and filtering.
- Seven-day history, recent tables, and 24-hour/7-day SVG charts.
- Durable agent outbox and idempotent report replay.
- Read-only file manager with directory tree, file preview, and per-application source shortcuts.
- Two hardened Docker containers and a fresh-install Beta script.

Not implemented: multiple servers, additional roles, HTTPS automation, alerts, Docker/PM2 inspection, commands, AI, or repairs.

## Architecture

- `symbio-mothership`: Hono, Mustache, Bootstrap, Sequelize 6, SQLite.
- `symbio-agent`: Hono diagnostics, host collectors, protocol/HTTP probes, SQLite outbox.
- `compose.yaml`: public dashboard, loopback agent API, host-networked read-only agent.
- `docs/001_first_phase.md`: complete Phase 1 requirements.
- `docs/002_first_phase_packing.md`: supporting Phase 1 packaging notes.
- `docs/003_first_and_half_phase.md`: canonical Phase 1.5 release and bounded-log draft.

All application code is plain JavaScript ESM. There is no TypeScript or SPA framework.

## Beta Installation

Prerequisites:

- Ubuntu 22.04, 24.04, or 26.04 LTS on amd64/arm64.
- Root access.
- Git.
- Docker Engine running.
- Docker Compose v2 (`docker compose`).

Run:

```sh
curl -fsSL https://raw.githubusercontent.com/senjasolutions/symbio/main/install.sh | sudo sh
```

The installer clones `main` because this is Beta software, builds both images, creates the superadmin interactively, waits for healthy containers, and installs under `/opt/symbio`.

### Security warning

The default dashboard is `http://0.0.0.0:8765`. It has no transport encryption. A public-IP deployment exposes login credentials and sessions to network interception even though passwords are safely hashed at rest.

Use only for Beta testing on a trusted network or behind an existing HTTPS reverse proxy. Symbio does not claim production-safe public access until HTTPS is provided.

The agent does not mount the Docker socket and does not offer commands or arbitrary filesystem access. It does use read-only host mounts for metrics/process evidence; review `docs/001_first_phase.md` before deployment.

## Local Docker Development

For the normal debugging loop, use the local development launcher:

```sh
./deploy-local.sh
```

It bind-mounts current mothership and agent source into the containers. Node
restarts automatically for imported JavaScript changes; Mustache, CSS, and
browser JavaScript changes appear on browser refresh. Useful controls:

```sh
./deploy-local.sh restart  # Fast manual process restart.
./deploy-local.sh logs     # Follow both service logs.
./deploy-local.sh status   # Show container and agent state.
./deploy-local.sh rebuild  # Required after dependency or Dockerfile changes.
./deploy-local.sh stop     # Retain local databases.
./deploy-local.sh reset    # Delete local databases and recreate the stack.
```

`deploy.sh` remains the separate Ubuntu VM installation test.

### Manual Compose workflow

Create a local agent token:

```sh
mkdir -p .symbio
umask 077
openssl rand -hex 32 > .symbio/agent-token
```

Build, migrate, and seed:

```sh
docker compose build
docker compose run --rm mothership npm run migrate
docker compose run --rm mothership npm run seed:superadmin
docker compose up -d
```

Open:

```text
http://127.0.0.1:8765
```

Inspect local agent status:

```sh
curl http://127.0.0.1:18767/api/v1/status
```

Stop while retaining data:

```sh
docker compose down
```

Remove Beta data explicitly:

```sh
docker compose down -v
```

## Non-Docker Development

Install both dependency sets:

```sh
sudo apt-get install build-essential python3
npm run install:all
```

The project postinstall step compiles SQLite against the local glibc so Ubuntu
22.04, 24.04, and 26.04 do not depend on an incompatible prebuilt binary.

Run checks and tests:

```sh
npm run check
npm test
```

Run mothership with temporary local state:

```sh
SYMBIO_DATABASE_PATH=/tmp/symbio-mothership.sqlite \
SYMBIO_AGENT_TOKEN=development-token \
PORT=8765 \
SYMBIO_INTERNAL_PORT=18766 \
npm --prefix mothership start
```

The agent normally needs the Compose host mounts and host network; run it through Compose for realistic collection.

## Disposable VM Installation Test

`deploy.sh` builds both images locally with Docker's cache, transfers the images
and exact current working tree directly to the configured Ubuntu test VM, runs
the real interactive installer in copied-source mode, and verifies both
container health and the first agent delivery. The VM test path does not
require or create a Git repository and does not rebuild images on the VM.

Defaults:

```text
Remote: root@192.168.123.242
SSH key: ~/.ssh/id_rsa
```

Run against a fresh VM:

```sh
./deploy.sh
```

Override the target or key without editing the script:

```sh
SYMBIO_TEST_REMOTE=root@192.0.2.10 \
SYMBIO_TEST_SSH_KEY="$HOME/.ssh/symbio-test" \
./deploy.sh
```

The script refuses to overwrite an existing installation without an explicit
mode. Replace application files and containers while preserving users,
monitoring history, applications, tags, settings, credentials, and databases:

```sh
./deploy.sh --reset
```

On a disposable test VM only, delete the complete installation and all data:

```sh
./deploy.sh --reset-data
```

`--reset-data` deletes the Symbio containers, named data volumes,
`/opt/symbio`, `/etc/symbio`, and `/var/log/symbio`. It cannot be combined with
`--reset`.

## Runtime Paths

- Installation source: `/opt/symbio`
- Deployment settings and agent token: `/etc/symbio`
- Installer log: `/var/log/symbio/install.log`
- Mothership SQLite: `/data/mothership.sqlite` inside its volume.
- Agent SQLite: `/data/agent.sqlite` inside its volume.

## Configuration

Common deployment overrides:

- `SYMBIO_BIND_IP` — public bind address, default `0.0.0.0`.
- `SYMBIO_PORT` — public dashboard port, default `8765`.
- `SYMBIO_INTERNAL_PORT` — loopback mothership agent port, default `18766`.
- `SYMBIO_AGENT_HEALTH_PORT` — loopback agent diagnostics, default `18767`.
- `SYMBIO_COOKIE_SECURE=1` — enable Secure session cookies only when the browser uses HTTPS.

Service host/port/URL overrides are edited from the authenticated Services page.

## License

Apache-2.0.
