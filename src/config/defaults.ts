import type { Config } from './types.js';

export const WORKFLOW_TEMPLATE_YAML = `name: Volt Notion Sync

# Triggers, in order of how this workflow gets woken up:
#   - repository_dispatch  — Fired by the Volt platform when Notion sends a
#                            webhook event for this project (debounced 60s).
#                            This is the primary path; expect ~5-30s end-to-end.
#   - schedule (6h cron)   — Safety net for missed/late webhooks and outages.
#   - workflow_dispatch    — Manual "sync now" from the GitHub UI.
#   - push                 — When a developer commits to .volt/ on main, push
#                            those changes back to Notion.
on:
  repository_dispatch:
    types: [notion-changed]
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:
  push:
    branches: [main]
    # Only trigger on markdown changes under .volt/ — the engine-managed
    # bundle (.volt/.cli/**), state file, and config don't need to push.
    paths:
      - '.volt/**/*.md'

concurrency:
  group: volt-notion-sync
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      # The CLI lives in Volt-Technologies/Volt-Notion-Sync. We pull it
      # via npx on every run so each project repo automatically picks up
      # engine updates without needing the bundle copied in. Pin to a tag
      # (e.g. github:Volt-Technologies/Volt-Notion-Sync#v0.2.0) if you
      # want a project to stop tracking main.
      - name: Cache npx download
        uses: actions/cache@v4
        with:
          path: ~/.npm/_npx
          key: npx-volt-notion-sync-\${{ runner.os }}

      # ─── Notion → repo (PULL ONLY) ────────────────────────────────
      # Triggered by webhook dispatch, cron, or manual run. We deliberately
      # do NOT push here — pushing on these triggers would write the just-
      # pulled markdown back to Notion, which Notion treats as another edit
      # and fires another webhook, looping forever.
      - name: Pull from Notion
        if: github.event_name != 'push'
        env:
          NOTION_TOKEN: \${{ secrets.NOTION_TOKEN }}
        run: npx --yes github:Volt-Technologies/Volt-Notion-Sync pull --repo "$GITHUB_WORKSPACE"

      - name: Commit pulled changes (direct-mode)
        if: github.event_name != 'push'
        run: |
          git config user.name  "volt-notion-sync[bot]"
          git config user.email "volt-notion-sync[bot]@users.noreply.github.com"
          if [ -n "$(git status --porcelain)" ]; then
            git add -A
            # [skip ci] keeps the resulting commit from re-triggering this
            # same workflow on the push trigger below.
            git commit -m "chore(notion-sync): pull $(date -u +%FT%TZ) [skip ci]"
            git push
          else
            echo "no changes"
          fi

      # ─── repo → Notion (PUSH ONLY) ────────────────────────────────
      # Only when a developer commits to .volt/**/*.md on main, and never
      # when the actor is our own bot or the commit was tagged [skip ci].
      #
      # Also: even if the workflow was triggered by a markdown change, the
      # specific files in this commit may all be ignored by localIgnore
      # patterns. We do an early exit here to avoid a useless Node startup.
      - name: Detect pushable markdown changes
        id: pushable_changes
        if: github.event_name == 'push' && github.actor != 'volt-notion-sync[bot]' && !contains(github.event.head_commit.message, '[skip ci]')
        run: |
          CHANGED_MD=$(git diff --name-only "\${{ github.event.before }}" "\${{ github.event.after }}" -- '.volt/**/*.md' || true)
          if [ -z "$CHANGED_MD" ]; then
            echo "no markdown changes in .volt/ — skipping push"
            echo "skip=true" >> "$GITHUB_OUTPUT"
          else
            echo "pushable .md files in this push:"
            echo "$CHANGED_MD"
            echo "skip=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Push to Notion
        if: github.event_name == 'push' && github.actor != 'volt-notion-sync[bot]' && !contains(github.event.head_commit.message, '[skip ci]') && steps.pushable_changes.outputs.skip != 'true'
        env:
          NOTION_TOKEN: \${{ secrets.NOTION_TOKEN }}
        run: npx --yes github:Volt-Technologies/Volt-Notion-Sync push --repo "$GITHUB_WORKSPACE"

      - name: Commit notion_id write-back from new pages
        if: github.event_name == 'push' && github.actor != 'volt-notion-sync[bot]' && !contains(github.event.head_commit.message, '[skip ci]') && steps.pushable_changes.outputs.skip != 'true'
        run: |
          git config user.name  "volt-notion-sync[bot]"
          git config user.email "volt-notion-sync[bot]@users.noreply.github.com"
          if [ -n "$(git status --porcelain)" ]; then
            git add -A
            git commit -m "chore(notion-sync): write back notion_id $(date -u +%FT%TZ) [skip ci]"
            git push
          fi

      # ─── PR-mode mappings ─────────────────────────────────────────
      # Same trigger logic as the direct-mode pull above.
      - name: Sync PR-mode mappings (open PR per mapping)
        if: github.event_name != 'push'
        env:
          NOTION_TOKEN: \${{ secrets.NOTION_TOKEN }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          ROUTES=$(npx --yes github:Volt-Technologies/Volt-Notion-Sync routes --no-resolve --repo "$GITHUB_WORKSPACE")
          PR_COUNT=$(echo "$ROUTES" | jq '.pr | length')
          if [ "$PR_COUNT" = "0" ]; then
            echo "no pr-mode mappings"
            exit 0
          fi
          npx --yes github:Volt-Technologies/Volt-Notion-Sync pull --repo "$GITHUB_WORKSPACE" || true
          if [ -z "$(git status --porcelain)" ]; then
            echo "no pr-mode changes"
            exit 0
          fi
          BRANCH="notion-sync/pr-$(date -u +%Y%m%d-%H%M%S)"
          git checkout -b "$BRANCH"
          git add -A
          git commit -m "chore(notion-sync): pr-mode pull $(date -u +%FT%TZ) [skip ci]"
          git push -u origin "$BRANCH"
          gh pr create \\
            --base main \\
            --head "$BRANCH" \\
            --title "Notion sync (review): $(date -u +%FT%TZ)" \\
            --body "Automated PR for review-required Notion mappings (commitStrategy: pr)."
`;

export const QUICKSTART_TEMPLATE_YAML = `version: 1
notion:
  teamspaceId: REPLACE_WITH_TEAMSPACE_UUID
  rootPageId: REPLACE_WITH_PROJECT_HOME_PAGE_UUID

defaultDirection: both
commitStrategy: direct
conflictPolicy: abort

mappings:
  - notion: "Process Flows"
    local: docs/process-flows
  - notion: "Waterfall Tasks"
    local: projectmanagement/waterfall-tasks
  - notion: "Project Definition"
    local: docs/project-definition
  - notion: "Features"
    local: docs/features
    optional: true
  - notion: "Resources"
    local: docs/resources
  - notion: "Miscellaneous"
    local: docs/misc

  - notion: "Meetings"
    local: projectmanagement/meetings
    type: database
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
  - "**/.gitkeep"
  - .sync-state.json

markdown:
  frontmatter: true
  attachments: .attachments
`;

export function makeDefaultConfig(teamspaceId: string, rootPageId: string): Config {
  return {
    version: 1,
    notion: { teamspaceId, rootPageId },
    defaultDirection: 'both',
    commitStrategy: 'direct',
    conflictPolicy: 'abort',
    mappings: [
      { notion: 'Process Flows', local: 'docs/process-flows', type: 'page', optional: false },
      { notion: 'Waterfall Tasks', local: 'projectmanagement/waterfall-tasks', type: 'page', optional: false },
      { notion: 'Project Definition', local: 'docs/project-definition', type: 'page', optional: false },
      { notion: 'Features', local: 'docs/features', type: 'page', optional: true },
      { notion: 'Resources', local: 'docs/resources', type: 'page', optional: false },
      { notion: 'Miscellaneous', local: 'docs/misc', type: 'page', optional: false },
      { notion: 'Meetings', local: 'projectmanagement/meetings', type: 'database', optional: false },
      {
        notion: 'PM Tasks',
        local: 'projectmanagement/pm-tasks',
        type: 'database',
        commitStrategy: 'pr',
        direction: 'pull',
        optional: false,
      },
    ],
    notionIgnore: ['Settings', 'Task Execution Log'],
    localIgnore: [
      'implementation/**',
      'powerbi/**',
      'tools/**',
      '**/*.al',
      '**/*.json',
      '**/*.csv',
      '**/.gitkeep',
      '.sync-state.json',
    ],
    markdown: { frontmatter: true, attachments: '.attachments' },
  };
}
