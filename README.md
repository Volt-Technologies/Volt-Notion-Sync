# Volt Notion Sync

Syncs a Notion teamspace to/from a project's GitHub repository as markdown under `.volt/`.

One Notion teamspace = one project repo. The Volt Consulting Platform (`Volt-Consulting-Platform/api`) reads the resulting markdown directly from GitHub.

## How it works

Each project repo has two files:

- `.volt/.volt-sync.yml` — mapping between Notion sections and `.volt/` folders. Editable per-project.
- `.github/workflows/volt-notion-sync.yml` — runs the sync engine on a schedule and on push.

The sync engine itself lives in this repo and is published as `@volt/notion-sync`. The project workflow installs and runs it; project repos hold no sync code.

## Commands

```
volt-notion-sync scaffold     Drop the workflow + config templates into the current repo
volt-notion-sync pull         Notion → repo
volt-notion-sync push         repo → Notion
volt-notion-sync sync         Both directions, conflict-aware (default for CI)
```

## Configuration

`.volt/.volt-sync.yml` example:

```yaml
version: 1
notion:
  teamspaceId: <uuid>
  rootPageId: <Project Home page uuid>

defaultDirection: both
commitStrategy: direct
conflictPolicy: abort

mappings:
  - notion: "Process Flows"
    local: docs/process-flows
  - notion: "PM Tasks"
    local: projectmanagement/pm-tasks
    type: database
    commitStrategy: pr
    direction: pull

notionIgnore:
  - "Settings"
  - "Task Execution Log"

localIgnore:
  - implementation/**
  - powerbi/**
  - tools/**
  - "**/*.al"
  - "**/*.json"
  - "**/*.csv"
```

## Authentication

`NOTION_TOKEN` — Notion integration token, set as a GitHub Actions secret on the project repo.
