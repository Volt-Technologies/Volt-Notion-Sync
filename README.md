# Volt Notion Sync

Bidirectional sync between a Notion teamspace and a project's GitHub repository. Notion pages and database rows live as markdown under `.volt/` in the repo. The Volt Consulting Platform reads that markdown directly to power agents, file browsers, and project dashboards.

## How it fits together

```
┌──────────┐  webhook event   ┌───────────────────────┐  repository_dispatch   ┌─────────────────────┐
│  Notion  │ ───────────────▶ │ Volt-Consulting-      │ ─────────────────────▶ │ GitHub Actions      │
│ teamspace│                  │ Platform/api          │                        │ in project repo     │
│          │  ◀ HTTP API      │  /api/notion/webhook  │                        │  (volt-notion-sync) │
└──────────┘                  └───────────────────────┘                        └─────────────────────┘
                                                                                          │
                                                                                          │ pull / push
                                                                                          ▼
                                                                                    ┌──────────┐
                                                                                    │ .volt/   │
                                                                                    │ in repo  │
                                                                                    └──────────┘
```

- **`Volt-Notion-Sync`** (this repo) is the sync engine — a TypeScript CLI bundled into a single 1.2 MB `.cjs` file. Each project repo carries its own copy under `.volt/.cli/` and runs it from a GitHub Actions workflow.
- **`Volt-Consulting-Platform/api`** is the relay between Notion and GitHub. Notion sends webhook events to a per-project URL there; the platform verifies HMAC signatures, debounces bursts, and fires a `repository_dispatch` to wake the project's workflow.
- **The project repo** holds the markdown source of truth (`.volt/<mapped folders>/*.md`), the workflow file (`.github/workflows/volt-notion-sync.yml`), the mapping config (`.volt/.volt-sync.yml`), and the bundled CLI (`.volt/.cli/volt-notion-sync.cjs`).

One Notion teamspace = one project repo.

## Onboarding a new project

### 1. Connect Notion in the Volt platform UI

In the Volt Consulting Platform, open the project's detail page → **Notion Integration** section → **Connect Notion**. Paste the project's Notion **Internal Integration Token** (created at https://www.notion.so/profile/integrations).

This stores the token on the project record (encrypted) and validates it against Notion's `/users/me` endpoint.

### 2. Scaffold the project repo

From a checkout of the project repo, run the bundled CLI's scaffold command:

```bash
node /path/to/Volt-Notion-Sync/bundle/volt-notion-sync.cjs scaffold \
  --bundle /path/to/Volt-Notion-Sync/bundle/volt-notion-sync.cjs
```

This drops three files into the repo:

| Path | Purpose |
|---|---|
| `.volt/.volt-sync.yml` | Mapping between Notion sections and `.volt/` folders. Editable. |
| `.volt/.cli/volt-notion-sync.cjs` | Self-contained sync engine (1.2 MB, version-pinned). |
| `.github/workflows/volt-notion-sync.yml` | Triggers + steps that run the engine. |

Edit `.volt/.volt-sync.yml`: set `notion.teamspaceId` and `notion.rootPageId` to the customer's teamspace UUID and Project Home page UUID.

### 3. Add the GitHub Actions secret

In the project's GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `NOTION_TOKEN` | The same Notion integration token from step 1 |

### 4. Set up the webhook (Volt platform UI)

Open the project page in the Volt platform → **Notion Integration → GitHub sync webhook → Set up webhook**.

The platform shows a callback URL like:

```
https://api.volt.../api/notion/webhook/<projectId>
```

Then it walks you through the 2-step Notion flow:

1. Open https://www.notion.so/profile/integrations → your integration → **Webhooks** tab → **Create subscription**. Paste the callback URL.
2. Notion POSTs a verification token to that URL. The platform captures it and displays it in the same panel.
3. Copy that verification token. Paste it into Notion's webhook setup form to confirm.

After step 3, the subscription is active in Notion. The webhook section shows **Configured** and offers a **Sync now** button (manual dispatch) and a **Reset** button (clear stored token).

### 5. First pull

Manually trigger the workflow once to do the initial pull:

```
gh workflow run volt-notion-sync.yml --repo <owner>/<projectRepo>
```

After the first run, `.volt/<mapped folders>/*.md` are committed to `main` and the platform API can read them.

## Triggers in the workflow

```yaml
on:
  repository_dispatch: { types: [notion-changed] }   # Notion → platform → here, ~5-30s end-to-end
  schedule:            { - cron: '0 */6 * * *' }     # safety net for missed webhooks
  workflow_dispatch:                                  # manual "sync now" from GH UI
  push:                { branches: [main], paths: ['.volt/**', '!.volt/.sync-state.json'] }
```

## Configuration: `.volt/.volt-sync.yml`

```yaml
version: 1

notion:
  teamspaceId: <uuid>
  rootPageId:  <Project Home page uuid>

defaultDirection: both        # pull | push | both
commitStrategy:   direct      # direct | pr — direct commits to main; pr opens a PR per mapping
conflictPolicy:   abort       # abort | notion-wins | github-wins

mappings:
  # Notion subtree → local path under .volt/
  - notion: "Process Flows"
    local:  docs/process-flows
  - notion: "PM Tasks"
    local:  projectmanagement/pm-tasks
    type:   database          # page (default) | database
    direction: pull           # override per-mapping
    commitStrategy: pr        # PM Tasks goes through PR review

# Notion items to never pull
notionIgnore:
  - "Settings"
  - "Task Execution Log"

# Local paths to never push (protects platform-managed files)
localIgnore:
  - implementation/**         # extension code, AL, schema-cache
  - powerbi/**
  - tools/**
  - "**/*.al"
  - "**/*.json"
  - "**/*.csv"
  - "**/.gitkeep"
  - .sync-state.json

markdown:
  frontmatter: true           # adds notion_id / notion_url / last_edited_time / properties
  attachments: .attachments
```

**Mapping fields:**

| Field | Default | Notes |
|---|---|---|
| `notion` | — | Display name of the page or database, looked up under `rootPageId` |
| `notionId` | — | UUID; takes precedence over `notion` (use to skip name lookup) |
| `local` | required | Folder path under `.volt/` |
| `type` | `page` | `page` for a page tree, `database` for a Notion database |
| `direction` | `defaultDirection` | `pull` skips push for this mapping; `push` skips pull |
| `commitStrategy` | `commitStrategy` | `pr` puts changes for this mapping into a separate branch + PR |
| `optional` | `false` | If `true`, mapping is silently skipped when the named child isn't found |

## CLI commands

Run from a project repo (where `.volt/.volt-sync.yml` lives) with `NOTION_TOKEN` in env. From CI this is the bundled CLI; locally you can also invoke `node /path/to/bundle/volt-notion-sync.cjs <cmd>`.

```
volt-notion-sync pull            Notion → repo
volt-notion-sync push            repo → Notion
volt-notion-sync push --mapping <name>     Limit push to one mapping
volt-notion-sync sync            Pull + push, with conflict policy applied
volt-notion-sync sync --strategy direct    Only handle direct-commit mappings
volt-notion-sync sync --strategy pr        Only handle PR-mode mappings
volt-notion-sync inspect         Print children under rootPageId (helps fill mappings)
volt-notion-sync routes          Emit JSON of mapping → strategy classification (used by workflow)
volt-notion-sync scaffold        Drop the workflow + config templates into the current repo
volt-notion-sync scaffold --bundle <path>  Also copy the CLI bundle into .volt/.cli/
```

## How sync handles changes

### Notion → repo (pull)

1. For each `page` mapping: walk the page tree under `notionId`, convert each page's blocks to markdown, write to `.volt/<local>/<...>/index.md`.
2. For each `database` mapping: query the data source, convert each row's body to markdown, write `.volt/<local>/<row-slug>.md` plus `.volt/<local>/_index.json` with the schema.
3. Stale `.md` files (under mapped folders, not present in this pull, not in `localIgnore`) are pruned.
4. Each entry is recorded in `.volt/.sync-state.json` with `notionLastEditedTime` and `contentHash` for next-run conflict detection.

### Repo → Notion (push)

1. Walks all `.md` files under each pushable mapping (skipping `localIgnore`).
2. For each file: reads frontmatter for `notion_id`. If present, updates the page (replacing all child blocks with a fresh conversion of the markdown body, plus property updates from frontmatter). If absent, creates a new page/row in Notion and writes the new `notion_id` + `notion_url` back into the local file's frontmatter.

### Conflict detection

A conflict is **both** sides changing the same entry since the last sync — local content hash differs from the recorded hash, AND `last_edited_time` from Notion differs from the recorded time.

Policies:
- `abort` — raise an error; CI fails; you investigate
- `notion-wins` — pull overwrites local for the conflicting entries; push skips them
- `github-wins` — pull skips them; push overwrites Notion

## Webhook signature verification

Notion signs webhook deliveries with `X-Notion-Signature: sha256=<hex>` where the signature is HMAC-SHA256 of the raw request body using the per-subscription `verification_token` as the key. The platform's receiver:

1. Captures the raw body bytes via Express's `verify` callback (Express's re-serialization is not byte-stable and would fail HMAC).
2. Looks up the stored `verification_token` for the project (`NOTION_WEBHOOK_TOKENS` org-setting, encrypted JSON map keyed by projectId).
3. Recomputes HMAC-SHA256 and compares with `crypto.timingSafeEqual`.
4. On match: schedules a debounced 60s timer per project. Within the window, additional events for the same project just reset the timer.
5. When the timer fires: looks up the project's `workspaceRepoUrl` and the org's `GITHUB_PAT`, and POSTs `/repos/{owner}/{repo}/dispatches` with `event_type: "notion-changed"`.

## Subscribed event types

By default the platform asks Notion for these:

- `page.content_updated` — block edits aggregated per page (the most common signal)
- `page.locked` — page locking
- `comment.created` — discussion activity
- `data_source.schema_updated` — DB schema changes (2025-09-03+ API version)

The actual selection happens in Notion's webhook setup form when the user creates the subscription — the platform shows the recommended list but Notion's UI has the final say.

## Cost & efficiency

| Trigger | Frequency | Cost |
|---|---|---|
| `repository_dispatch` (webhook) | per actual change, debounced 60s | minutes/month per project, scales with activity |
| Cron (safety net) | every 6 h | ~60 min/month per private repo |
| `push` | when devs commit `.volt/**` to main | only on real commits |
| `workflow_dispatch` | manual | rare |

Compared to a 15-min cron that runs ~2,880 times/month per repo regardless of activity (and bills against GH Actions free tier on private repos), this is roughly **100× cheaper** at idle.

## Known limitations

- **Notion webhook subscriptions are UI-only.** Notion does not expose a REST API to create them, so the "Set up webhook" button in the platform walks the user through Notion's webhook setup form instead of automating it.
- **Multi-instance API debounce.** The 60s debounce is in-memory. Behind a load balancer with > 1 replica, each replica debounces independently. The workflow's `concurrency: volt-notion-sync` group means duplicate dispatches still serialize, so it's safe — just slightly less efficient. Move debounce to Redis if/when this matters.
- **Notion-native blocks that don't round-trip via markdown:** synced blocks, AI blocks, certain embeds. They're rendered as `<!-- unsupported block -->` placeholders on pull, and a push from markdown will replace them. The contract is "markdown is the source of truth on the file side"; for Notion-only rich content, edit in Notion.
- **AL code blocks** map to Notion's `plain text` language because `al` isn't in Notion's supported list — the code is preserved, just no syntax highlighting.
- **Image/file/video attachments** are kept as URLs to Notion's CDN. Local download into `<mapping>/.attachments` is a future enhancement.

## Repo layout

```
src/
├── cli.ts                  Commander entry (pull/push/sync/inspect/routes/scaffold)
├── config/
│   ├── types.ts            Zod schemas + ResolvedMapping types
│   ├── load.ts             Loads + validates .volt-sync.yml
│   └── defaults.ts         QUICKSTART_TEMPLATE_YAML, WORKFLOW_TEMPLATE_YAML
├── notion/
│   ├── client.ts           @notionhq/client wrapper
│   ├── walker.ts           Walks page tree
│   ├── blocksToMarkdown.ts Page blocks → markdown
│   └── database.ts         Database export via 2025-09-03 data sources API
├── markdown/
│   ├── parse.ts            gray-matter frontmatter + body
│   ├── toBlocks.ts         markdown → Notion blocks (via marked)
│   └── walker.ts           Walks .md files in repo
├── mapping/
│   ├── resolve.ts          Names → ids; respects `optional`
│   └── glob.ts             minimatch ignore matching
├── sync/
│   ├── pull.ts             Pull pipeline
│   ├── push.ts             Push pipeline
│   ├── conflict.ts         Conflict detection + policy
│   └── state.ts            .sync-state.json
└── github/pr.ts            (stub for future PR-mode helpers)
templates/
├── volt-sync.yml           Reference copy of the seed config
└── workflow.yml            Reference copy of the GH Actions workflow
bundle/
└── volt-notion-sync.cjs    esbuild output, used by consumer repos
```

## Development

```
npm install
npm run build            tsc to dist/
npm run typecheck        tsc --noEmit
npm run bundle           tsc + esbuild → bundle/volt-notion-sync.cjs
node dist/cli.js <cmd>   Run from source
node bundle/volt-notion-sync.cjs <cmd>   Run from bundle
```

## Authentication

| Where | What |
|---|---|
| Local CLI | `NOTION_TOKEN` env var — the project's Notion integration secret |
| Project's GH Actions | `NOTION_TOKEN` repository secret — same value |
| Volt platform | `Projects.NotionApiKey` (encrypted) — set by the "Connect Notion" flow |
| Webhook receiver | Per-project `verification_token` stored in `NOTION_WEBHOOK_TOKENS` org-setting (encrypted JSON map) |
| GitHub dispatch | `GITHUB_PAT` org-setting — must have `repo` scope to call `repository_dispatch` |
