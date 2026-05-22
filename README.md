# Symbio

Open-source AI runtime resilience for web servers.

Symbio is being built as a self-hosted Docker agent that lives beside a website or web application, helps diagnose failures, prepares safe fixes, and starts from a browser-based onboarding flow.

This repository currently contains the first implementation slice: a Dockerized local onboarding prototype.

## Current Status

Prototype stage.

Implemented:

- One-command local install script.
- Docker image build from this repository.
- Local container named `symbio-agent`.
- Browser onboarding UI.
- Onboarding config persistence in a Docker volume.
- Basic health/status endpoint.
- Read-only multi-page target health checks.
- Protection against saving the OpenRouter key value into onboarding JSON.

Not implemented yet:

- Continuous website monitoring.
- Docker or application inspection.
- OpenRouter model calls.
- Stack adapters.
- Incident diagnosis.
- Repair proposals.
- Security patching.
- Production mutation.
- Cloud intelligence.

## Install

Prerequisites:

- Docker installed and running on the webserver.
- Git installed on the webserver.

Run:

```bash
git clone https://github.com/senjasolutions/symbio.git && ./symbio/install.sh
```

Default onboarding URL:

```text
http://127.0.0.1:8765
```

If this is a remote webserver, use SSH port forwarding or expose port `8765` only to trusted networks.

Example SSH port forwarding:

```bash
ssh -L 8765:127.0.0.1:8765 user@your-server
```

Then open:

```text
http://127.0.0.1:8765
```

## What The Installer Does

`install.sh` performs these steps:

1. Checks that Docker is installed and the Docker daemon is reachable.
2. Builds a local Docker image named `symbio-agent:local`.
3. Creates a Docker volume named `symbio-agent-data`.
4. Removes any existing container named `symbio-agent`.
5. Starts a new `symbio-agent` container.
6. Maps host port `8765` to container port `8080`.
7. Prints the onboarding URL.
8. Attempts to open the onboarding URL when a local browser opener exists.

The container runs a dependency-free Node.js HTTP server from `app/server.js`.

## Update Existing Install

From the parent folder that contains the existing `symbio` clone:

```bash
git -C symbio pull && ./symbio/install.sh
```

This rebuilds the local image and replaces the running `symbio-agent`
container while preserving the `symbio-agent-data` Docker volume.

## Onboarding Flow

The browser onboarding form currently asks for:

- Mode: `Self-Hosted Solo Mode` or `Agency Mode`.
- Site name.
- Site URL.
- Health check paths.
- Owner email.
- Automation level.
- OpenRouter key.

The default automation level is `Guided Repair`.

The prototype records whether an OpenRouter key was provided, but it does not save the key value into `onboarding.json`.

## Data Storage

Onboarding data is saved inside the Docker volume:

```text
symbio-agent-data
```

Inside the container, the config path is:

```text
/data/onboarding.json
```

The saved JSON includes:

- Setup ID.
- Timestamps.
- Mode.
- Site name.
- Site URL.
- Health check paths.
- Owner email.
- Automation level.
- Whether an OpenRouter key was provided.
- Protected-zone lock status.

It does not store:

- OpenRouter key value.
- Secrets.
- Environment values.
- Database data.
- Source code.
- Logs.

## Safety Boundaries In This Prototype

This prototype does not mutate production systems.

It does not:

- Edit files.
- Edit configs.
- Edit `.env` values.
- Read or write databases.
- Upgrade dependencies.
- Restart target application containers.
- Run repair commands.
- Upload logs or source code.
- Send telemetry to Symbio Cloud.

The onboarding config always marks protected zones as locked.

Protected zones include:

- Secrets.
- Auth.
- Billing.
- Payments.
- Production database schema.
- Production database data.

Read-only health checks only send HTTP GET requests to the configured site URL
and same-origin paths saved during onboarding.

## Local Development

Run the server without Docker:

```bash
PORT=8766 SYMBIO_DATA_DIR=/tmp/symbio-agent-test npm start
```

Health check:

```bash
curl http://127.0.0.1:8766/api/status
```

Target page health check:

```bash
curl http://127.0.0.1:8766/api/health
```

Syntax check:

```bash
npm run check
```

## API Endpoints

### `GET /api/status`

Returns service health and saved onboarding config when present.

Example:

```bash
curl http://127.0.0.1:8765/api/status
```

### `GET /api/health`

Runs read-only HTTP checks against the configured site URL and saved health
paths.

Example:

```bash
curl http://127.0.0.1:8765/api/health
```

The response includes:

- Overall status: `healthy`, `warning`, or `down`.
- Counts for total, ok, and failing pages.
- Per-page URL, status code, response time, content type, and error when
  present.
- A safety marker confirming read-only mode and no production mutation.

### `POST /api/onboarding`

Saves onboarding setup.

Example:

```bash
curl -X POST http://127.0.0.1:8765/api/onboarding \
  -H 'content-type: application/json' \
  --data '{
    "mode": "self-hosted-solo",
    "siteName": "Example Site",
    "siteUrl": "https://example.com",
    "ownerEmail": "owner@example.com",
    "automationLevel": "guided-repair",
    "healthPaths": "/\n/features\n/pricing\n/blog\n/help",
    "openRouterKey": "not-saved"
  }'
```

## Troubleshooting

### Docker daemon is not reachable

If install prints:

```text
Docker CLI is installed, but the Docker daemon is not reachable.
```

Start Docker, then rerun:

```bash
./symbio/install.sh
```

### Port 8765 is already in use

Choose another host port:

```bash
SYMBIO_PORT=8877 ./symbio/install.sh
```

Then open:

```text
http://127.0.0.1:8877
```

### Replace the existing container

The installer automatically replaces an existing container named `symbio-agent`.

The data volume is preserved unless you manually remove it.

## Roadmap

Next implementation targets:

1. Add scheduled health checks and incident persistence.
2. Add adapter detection for WordPress and Laravel.
3. Add incident model: Incident, Issue, Action, PolicyDecision, Execution, Validation, AuditEvent.
4. Add policy-gated safe recovery actions.
5. Add OpenRouter proposal layer through controlled tools.
6. Add benchmark lab for Laravel operational recovery and WordPress security patching.

## License

Apache-2.0.
