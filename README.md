# Symbio Agent Prototype

First implementation target: one command starts a Docker container and opens a browser-based onboarding flow.

## Local Install

From this folder:

```bash
./install.sh
```

Default onboarding URL:

```text
http://127.0.0.1:8765
```

## What This Prototype Does

- Builds the local Docker image.
- Starts one container named `symbio-agent`.
- Serves an onboarding UI from inside the container.
- Stores onboarding configuration in the Docker volume `symbio-agent-data`.
- Keeps the OpenRouter key out of the saved JSON config; v1 expects it to be passed as `OPENROUTER_API_KEY` when real model calls are implemented.

## What This Prototype Does Not Do Yet

- It does not monitor real applications.
- It does not connect to OpenRouter.
- It does not mutate files, containers, databases, configs, or dependencies.
- It does not install a published image from a registry.

