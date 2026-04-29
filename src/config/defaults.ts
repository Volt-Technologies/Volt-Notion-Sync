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
    paths:
      - '.volt/**'
      - '!.volt/.sync-state.json'

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

      - name: Sync direct-mode mappings (commit to main)
        env:
          NOTION_TOKEN: \${{ secrets.NOTION_TOKEN }}
        run: node .volt/.cli/volt-notion-sync.cjs sync --repo "$GITHUB_WORKSPACE" --strategy direct

      - name: Commit and push direct-mode changes
        run: |
          git config user.name  "volt-notion-sync[bot]"
          git config user.email "volt-notion-sync[bot]@users.noreply.github.com"
          if [ -n "$(git status --porcelain)" ]; then
            git add -A
            git commit -m "chore(notion-sync): pull $(date -u +%FT%TZ)"
            git push
          fi

      - name: Sync PR-mode mappings (open PR per mapping)
        env:
          NOTION_TOKEN: \${{ secrets.NOTION_TOKEN }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          ROUTES=$(node .volt/.cli/volt-notion-sync.cjs routes --no-resolve --repo "$GITHUB_WORKSPACE")
          PR_COUNT=$(echo "$ROUTES" | jq '.pr | length')
          if [ "$PR_COUNT" = "0" ]; then
            echo "no pr-mode mappings"
            exit 0
          fi
          node .volt/.cli/volt-notion-sync.cjs sync --repo "$GITHUB_WORKSPACE" --strategy pr || true
          if [ -z "$(git status --porcelain)" ]; then
            echo "no pr-mode changes"
            exit 0
          fi
          BRANCH="notion-sync/pr-$(date -u +%Y%m%d-%H%M%S)"
          git checkout -b "$BRANCH"
          git add -A
          git commit -m "chore(notion-sync): pr-mode pull $(date -u +%FT%TZ)"
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
