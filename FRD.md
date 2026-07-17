# Symbio Functional Requirements

## 1. Product Definition

Symbio is a **DevOps AI Agent first**, monitoring dashboard second. A lightweight, self-hosted DevOps AI assistant for Linux servers. The monitoring dashboard exists as the data source for the AI and human-proof verification. The real product is the autonomous AI skill system (Symbio Intelligence) that handles basic DevOps maintenance — package updates, storage cleanup, service uptime monitoring, error scanning, config optimization — freeing human operators for complex work.

The Command Center (`/ai/command-center`) is the primary user interface.

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
- [`docs/004_symbio_intelligence.md`](docs/004_symbio_intelligence.md): Symbio Intelligence design — AI skill system, Command Center, agent bridge execution.
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
- Navigation and controls use a Soft Neumorphism design system — soft embossed
  shadows, rounded corners (14px), gradient card headers, pastel backgrounds.
  Three server-wide color schemes are available: Blue (default), Red, Green.
  Theme is selectable via Settings General tab and Setup Wizard step 1.
  CSS uses plain custom properties on `<html class="theme-{blue|red|green}">`.
  Symbio does not reuse cPanel/WHM source, assets, logos, or implementation code.

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
- Internationalization: all UI text uses Mustache `{{#t}}key{{/t}}` section lambdas.
  Locale JSON files in `mothership/src/i18n/` support English (default), German,
  Bahasa Indonesia, and Sundanese. Language is per-user via `users.language`
  column, configurable from the Profile page. Login/guest pages always render
  in English. Fallback chain: user locale → `en.json` → raw key.
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
- Dark mode.
- Docker/PM2 inspection beyond Phase 1 evidence.
- ~~Notifications, incident diagnosis, safe commands, repairs, and policy-gated mutations.~~

### Phase 2 — Symbio Intelligence (DevOps AI Agent)

Phase 2 pivots Symbio from a monitoring dashboard to an AI-first DevOps agent. The monitoring dashboard becomes the data source and human-verification layer. The real product is Symbio Intelligence: autonomous skills that perform basic DevOps maintenance.

Key additions:
- **Skill system framework** with 5 pluggable modules: Package Updater, Storage Maid, Uptime Police, Error Finder, Optimizer (see `docs/004_symbio_intelligence.md` for complete design).
- **Modular skill lifecycle**: collect → filter → analyze (LLM) → report. Each module has standard lifecycle hooks with config and memory support.
- **Command Center** (`/ai/command-center`) — main UI showing skill cards with enable/disable toggle, Run Now button, status badges, recent activity timeline, and pending actions preview. Links to AI History and Token Usage.
- **Agent bridge** extended with `POST /api/v1/skills/collect` (bulk data collection) and `POST /api/v1/skills/execute` (whitelisted action execution). 16 action types mapped to hardcoded `execFile()` calls; no shell, no arbitrary commands.
- **Action management** with full user control: approve, reject, or mark-as-done for pending actions. Dedicated `/ai/actions` page with action history. Inline Apply/Ignore/Mark Done buttons.
- **Before/after proof system**: every executed action captures system state before and after (`df -h`, service status, package list). Proof stored in `skill_actions.result` and displayed as expandable `<details>` in action history.
- **Per-skill configuration** via `/ai/command-center/:key/settings` — intensity, exclude dirs, monitored services, ignore patterns, categories, etc. Config stored in skills table `config` JSON column.
- **Memory system**: each skill has a `memory` text column. LLM reads past context before analysis and can write new observations. User can view and edit memory from settings page.
- **Tiered safety model**: Tier 1 auto-execute (apt clean, journalctl vacuum) with before/after proof capture. Tier 2 needs human approval (upgrades, restarts, file deletion, config changes).
- **LLM integration**: `callSkillAI()` function with per-skill system prompts, `response_format: json_object` for structured JSON output, token usage tracking per skill run.
- **Setup Wizard**: 2-step onboarding (language + LLM config). Re-runnable from Settings. Standalone centered layout.
- **Sidebar nav**: Symbio Intelligence section with Command Center, AI History, Token Usage, Pending Actions links.
- **Database**: 5 new tables (skills, skill_runs, skill_findings, skill_actions, notifications), migration v9. Memory column added in migration v10.

Phase 2 implemented files:
- `agent/src/skills-executor.js` — 16 whitelisted action handlers
- `agent/src/skills-collector.js` — bulk data collection
- `mothership/src/services/skills/index.js` — skill registry
- `mothership/src/services/skills/scheduler.js` — interval scheduler with lifecycle hooks
- `mothership/src/services/skills/error-finder.js` — log error scanner
- `mothership/src/services/skills/storage-maid.js` — disk cleanup
- `mothership/src/services/skills/package-updater.js` — package update checker
- `mothership/src/services/skills/uptime-police.js` — service uptime monitor
- `mothership/src/services/skills/optimizer.js` — config optimization advisor
- `mothership/src/services/skills/proof.js` — before/after proof capture
- `mothership/src/services/agent-client.js` — agent bridge HTTP client
- `mothership/src/views/ai-command-center.mustache` — Command Center
- `mothership/src/views/ai-actions.mustache` — pending actions management
- `mothership/src/views/ai-usage.mustache` — token usage page
- `mothership/src/views/skill-settings.mustache` — per-skill settings
- `mothership/src/views/setup-wizard.mustache` — onboarding wizard

Phase 2 non-goals:
- Multi-server support for skills (still targets single server).
- Custom user-created skills (only 5 built-in).
- ~~Webhook/email notifications.~~ (Implemented in Phase 2.5 — Alert System)
- Historical trend charts for skills (disk usage over time, error frequency).
- Auto-approval scheduling.
- Rollback support.

### Phase 2.5 — Alert System

Alert system extends monitoring with user-defined threshold rules, state-transition
notifications (monit-style matched/succeeded), and modular notification channels.

Key additions:
- **Alert Rules**: per-metric threshold definitions (CPU, memory, swap, disk, load,
  CPU I/O wait) with configurable duration, cooldown, severity, and notification
  channels.
- **Alert Engine**: server-side timer (30s) checks `server_statuses` against enabled
  rules. Fires when ALL samples in the duration window exceed the threshold.
  Resolves when the latest sample drops below. Sends notifications on state
  transitions only (notfiring→firing and firing→resolved).
- **State tracking**: each alert cycle is recorded as an `alert_events` row with
  `firing`/`resolved`/`acknowledged` status. Cooldown prevents notification spam.
- **Diagnostic data**: when an alert fires, the engine fetches top 5 CPU and
  memory processes from the agent bridge for root-cause analysis.
- **Notification channels**: modular registry (`services/notifications/`) starting
  with Slack incoming webhook. Channel configuration via Settings → Messaging
  Integration tab. Each alert rule can target specific channels.
- **Alert UI** (`/alerts`): rules management (create/edit/delete/toggle), firing
  alerts with diagnostic expand, recent event history. Firing alerts also shown
  as a banner on the dashboard.
- **CPU I/O Wait metric**: added to host collector, server_statuses, and models.
- **Agent bridge**: new `GET /api/v1/system/top-processes` endpoint returns top
  CPU and memory consumers from `/proc`.
- **Database**: 3 new tables (`alert_rules`, `alert_events`, `notification_channels`),
  migration v12. Six default rules seeded.
- **Settings**: new "Messaging Integration" tab (4th tab) for managing notification
  channels.

### Phase 2.6 — UI Modernization (Soft Neumorphism)

Complete visual redesign replacing the cPanel/WHM-inspired 2010s aesthetic with
a modern Soft Neumorphism design system.

Key additions:
- **Soft Neumorphism CSS**: embossed shadows (4px/8px dark + -4px/-8px light),
  14px border-radius on all cards/panels, gradient card headers, pastel color
  palette.
- **Server-wide color schemes**: Blue (default), Red, Green. Accent colors use
  soft/muted tones. Theme stored in `settings` table (key `theme`, default `blue`).
- **Theme selector**: Setup Wizard step 1 (alongside language picker) and
  Settings → General tab (dropdown + save button). `POST /settings/theme` route.
- **CSS architecture**: single `styles.css`, no build tools. Theme via CSS custom
  properties on `<html class="theme-{blue|red|green}">`. All existing class names
  preserved for zero template changes.
- **Migration v14**: seeds `theme = 'blue'`.

Phase 2.6 implemented files:
- `mothership/public/styles.css` — complete rewrite
- `mothership/src/db/migrations.js` — v13 migration
- `mothership/src/lib/render.js` — `THEME_CHOICES`, theme read per-request
- `mothership/src/views/base.mustache` — `<html class="theme-{{theme}}">`
- `mothership/src/views/setup-wizard.mustache` — step 1 theme selector
- `mothership/src/views/settings.mustache` — General tab theme form
- `mothership/src/routes/web.js` — wizard + settings theme handling
- `mothership/src/i18n/en.json` — `settings.theme` keys
- `AGENTS.md` — updated design philosophy

Phase 2.5 implemented files:
- `agent/src/collectors/host.js` — cpuIowaitPercent added to collectCpu()
- `agent/src/system.js` — getTopProcesses() added
- `agent/src/app.js` — GET /api/v1/system/top-processes route
- `mothership/src/db/migrations.js` — v12 (3 tables + cpu_iowait column)
- `mothership/src/db/models.js` — AlertRule, AlertEvent, NotificationChannel models
- `mothership/src/services/alert-engine.js` — threshold checker + event lifecycle
- `mothership/src/services/notifications/index.js` — channel registry + dispatch
- `mothership/src/services/notifications/slack.js` — Slack Block Kit sender
- `mothership/src/services/system.service.js` — fetchTopProcesses()
- `mothership/src/routes/web.js` — /alerts/* + settings messaging routes
- `mothership/src/views/alerts.mustache` — alerts management page
- `mothership/src/views/alert-rule-form.mustache` — create/edit rule form
- `mothership/src/views/base.mustache` — sidebar Alert link
- `mothership/src/views/settings.mustache` — Messaging Integration tab
- `mothership/src/views/dashboard.mustache` — firing alerts banner
- `mothership/src/lib/render.js` — alertsActive nav state
- `mothership/src/index.js` — startAlertEngine/stopAlertEngine
- `mothership/src/i18n/en.json` — alerts + settings.messaging keys

## 5. Explicit Global Non-Goals for Phase 1

- Repository, Docker-container, or source-code inspection. Registered ordinary application log files and read-only file browsing are the bounded exception.
- Arbitrary shell execution or file mutation.
- Service restart or host mutation.
- Database credentials or authenticated service queries.
- Multi-server registration.
- LLM calls for deeper analysis (basic log analysis implemented in Phase 1).
- Automated HTTPS or firewall modification.
- PostgreSQL as Symbio's own storage backend.

## 6. Current Technology Decisions

- Runtime: Node.js 24 LTS, plain JavaScript ESM.
- HTTP: Hono and `@hono/node-server`.
- Views: Mustache and locally served Bootstrap.
- Persistence: Sequelize 6 with explicit SQLite migrations.
- Password storage: Argon2id.
- LLM: DeepSeek primary via OpenAI-compatible format; OpenAI and Anthropic also supported. Non-streaming, server-side calls from mothership. Token usage tracked.
- Deployment: Docker Compose on Ubuntu 22.04, 24.04, or 26.04 LTS, amd64 or arm64.

Sequelize is an application boundary for a later PostgreSQL adapter. PostgreSQL portability is not automatic: later work still requires PostgreSQL migrations and contract tests.

## 10. Cross-Run Finding Deduplication (v17, 2026-07-16)

Migration v17 adds `pattern`, `seen_count`, `last_seen_at`, `status` columns to `skill_findings` with index on `(pattern, status)`.

**Flow:** `upsertFinding()` helper checks for existing open finding with same `pattern` from same skill before inserting. If found: increment `seen_count`, update `last_seen_at`, skip notification/action. If new: create finding with `status='open'`, create actions and notifications. All 6 skills emit `pattern` in LLM JSON. Dismiss routes close findings. `ignorePatterns` filter prevents re-creation of dismissed patterns. UI shows `Seen: Nx` badge for `seen_count > 1`.

## 11. Safety — Auto-Execution Disabled (2026-07-16)

All skill auto-execution has been removed for safety. `error-finder.js` and `uptime-police.js` `execute()` methods now return empty arrays unconditionally. Every action now requires human approval via the pending actions workflow. This is a hard safety boundary — no configuration can re-enable auto-execution.
