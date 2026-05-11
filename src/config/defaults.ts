import type { Mapping } from './types.js';

// Canonical Quickstart mappings — pages and databases that exist as
// children of the Project Home page in every standard Volt customer
// project. Baked into the CLI so consumer repos don't have to copy them
// into every `.volt-sync.yml`. All marked `optional: true` so a repo
// where one of them isn't configured yet doesn't fail the run.
//
// Repos override individual entries by listing the same `notion:` name
// in their own `mappings:` array. Set `disabled: true` on an override
// to skip a standard mapping entirely; set `useStandardMappings: false`
// at the top level to opt out of all of them.
//
// Verified against White & Warren's Project Home tree (2026-05-05).
//
// Quickstart projects also expose canonical databases under
// Settings → Databases (Waterfall Tasks, Issues, Sprints, etc.). Those
// aren't direct children of Project Home; the resolver discovers them
// via a deep tree scan when a database-typed standard mapping doesn't
// match a direct child by name.
export const STANDARD_MAPPINGS: Mapping[] = [
  // ── Page trees ────────────────────────────────────────────────────
  {
    notion: 'Process Flows',
    local: 'docs/process-flows',
    type: 'page',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Waterfall Tasks',
    local: 'projectmanagement/waterfall-tasks',
    type: 'page',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Project Definition',
    local: 'docs/project-definition',
    type: 'page',
    optional: true,
    disabled: false,
  },
  // ── Databases (canonical, under Settings → Databases) ─────────────
  // Waterfall Tasks rows are grouped into Type-named subfolders
  // (extension/, migration/, integration/, reports/, training/) by the
  // canonical "Type" select property. The Volt platform reads each
  // type's rows directly from its subfolder — no per-file Type filter
  // needed. Stage artifacts (FDD, TDD, documentation, test-report) live
  // in a sibling <slug>/ folder inside the same group.
  {
    notion: 'Meetings',
    local: 'projectmanagement/meetings',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Waterfall Tasks',
    local: 'projectmanagement/waterfall-tasks',
    type: 'database',
    optional: true,
    disabled: false,
    groupByProperty: 'Type',
  },
  {
    notion: 'Issues',
    local: 'projectmanagement/issues',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Sprints',
    local: 'projectmanagement/sprints',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Milestones',
    local: 'projectmanagement/milestones',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Phases',
    local: 'projectmanagement/phases',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Project Members',
    local: 'projectmanagement/project-members',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Process Flows',
    local: 'projectmanagement/process-flows',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Abstract Process Flows',
    local: 'projectmanagement/abstract-process-flows',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Notes',
    local: 'projectmanagement/notes',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Sprint Goals',
    local: 'projectmanagement/sprint-goals',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Transcripts',
    local: 'projectmanagement/transcripts',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Project Notes',
    local: 'projectmanagement/project-notes',
    type: 'database',
    optional: true,
    disabled: false,
  },
  {
    notion: 'Subtasks',
    local: 'projectmanagement/subtasks',
    type: 'database',
    optional: true,
    disabled: false,
  },
];

// Standard items the CLI always ignores on pull/push. Concatenated with
// repo-defined entries (no de-dup needed; minimatch handles overlap).
export const STANDARD_NOTION_IGNORE: string[] = ['Settings', 'Task Execution Log'];

export const STANDARD_LOCAL_IGNORE: string[] = [
  '**/*.al',
  '**/*.json',
  '**/*.csv',
  '**/.gitkeep',
  '.sync-state.json',
];

// Merge the standard mappings into the repo-defined list.
//
// Matching rule: a repo entry matches a standard when their `notion:`
// names match AND either (a) the repo entry omits `type`, or (b) the
// repo's `type` equals the standard's. This lets a repo override
// "Meetings" (a standard database) with just `notion: "Meetings",
// notionId: ...` (inheriting type=database), while still allowing the
// repo to declare a separate "Meetings" page as a pure extra by writing
// `type: page` explicitly.
//
// Override fields beat standard fields where present; missing fields
// inherit. `disabled: true` drops the standard from the resolved list.
// Pure repo extras pass through and get type='page' if unspecified.
export function mergeMappings(
  repo: Mapping[],
  useStandard: boolean,
): Mapping[] {
  if (!useStandard) {
    return repo.map(fillTypeDefault);
  }

  const out: Mapping[] = [];
  // Key by (notion, type) so an override targeting the "Waterfall
  // Tasks" page doesn't accidentally also override the "Waterfall
  // Tasks" database standard with the same name. When the repo entry
  // omits `type`, we use the matched standard's type as the key.
  const overridesByStdKey = new Map<string, Mapping>();
  const repoExtras: Mapping[] = [];

  for (const m of repo) {
    const std = m.notion
      ? STANDARD_MAPPINGS.find(
          (s) => s.notion === m.notion && (m.type === undefined || s.type === m.type),
        )
      : undefined;
    if (std) {
      overridesByStdKey.set(stdKey(std), m);
    } else {
      if (!m.local) {
        throw new Error(
          `Repo-defined mapping "${m.notion ?? m.notionId}" must specify \`local:\` ` +
            `(it doesn't match any standard mapping to inherit from).`,
        );
      }
      repoExtras.push(fillTypeDefault(m));
    }
  }

  for (const std of STANDARD_MAPPINGS) {
    const override = overridesByStdKey.get(stdKey(std));
    if (!override) {
      out.push(std);
      continue;
    }
    if (override.disabled) continue;
    out.push({
      ...std,
      ...stripUndefined(override),
      // Inherit `local` and `type` from standard when override omits them
      local: override.local ?? std.local,
      type: override.type ?? std.type,
    });
  }

  out.push(...repoExtras);
  return out;
}

function stdKey(m: Mapping): string {
  return `${m.notion}|${m.type ?? 'page'}`;
}

function fillTypeDefault(m: Mapping): Mapping {
  return m.type === undefined ? { ...m, type: 'page' } : m;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const r: Partial<T> = {};
  for (const [k, v] of Object.entries(o) as [keyof T, T[keyof T]][]) {
    if (v !== undefined) r[k] = v;
  }
  return r;
}

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
      #
      # Webhook (repository_dispatch) carries a notionEntityId in the
      # client_payload — we pass that as --entity so the CLI only re-pulls
      # the mapping containing that entity (~14× cheaper for a typical
      # Quickstart project). Cron + manual runs do a full pull as a safety
      # net for missed/late/aggregated webhook events.
      - name: Pull from Notion (targeted on webhook, full on cron/manual)
        if: github.event_name != 'push'
        env:
          NOTION_TOKEN: \${{ secrets.NOTION_TOKEN }}
          # Field names here match what the Azure Logic App (notion-github-sync)
          # writes into client_payload — entity.id / entity.type come from
          # the raw Notion webhook entity object; notion_event_type is the
          # snake_case Notion event name (page.content_updated, page.deleted,
          # data_source.schema_updated, ...).
          NOTION_ENTITY_ID:   \${{ github.event.client_payload.entity.id }}
          NOTION_ENTITY_TYPE: \${{ github.event.client_payload.entity.type }}
          NOTION_EVENT_TYPE:  \${{ github.event.client_payload.notion_event_type }}
        run: |
          if [ "\${{ github.event_name }}" = "repository_dispatch" ] && [ -n "$NOTION_ENTITY_ID" ]; then
            echo "targeted pull: entity=$NOTION_ENTITY_ID type=\${NOTION_ENTITY_TYPE:-page} event=\${NOTION_EVENT_TYPE:-(none)}"
            npx --yes github:Volt-Technologies/Volt-Notion-Sync pull \\
              --repo "$GITHUB_WORKSPACE" \\
              --entity "$NOTION_ENTITY_ID" \\
              \${NOTION_ENTITY_TYPE:+--entity-type "$NOTION_ENTITY_TYPE"} \\
              \${NOTION_EVENT_TYPE:+--event "$NOTION_EVENT_TYPE"}
          else
            echo "full pull"
            npx --yes github:Volt-Technologies/Volt-Notion-Sync pull --repo "$GITHUB_WORKSPACE"
          fi

      - name: Commit pulled changes (direct-mode)
        if: github.event_name != 'push'
        run: |
          git config user.name  "volt-notion-sync[bot]"
          git config user.email "volt-notion-sync[bot]@users.noreply.github.com"
          # Stage everything, then unstage the sync-state file. That file
          # holds lastPullAt, which the engine rewrites on every pull —
          # including pulls where no Notion content changed. Without this
          # filter, every cron tick would create a noisy timestamp-only
          # commit. We still write it locally for the next run on the
          # same runner; we just don't push it.
          git add -A
          git reset HEAD '.volt/.sync-state.json' >/dev/null 2>&1 || true
          if ! git diff --cached --quiet; then
            # [skip ci] keeps the resulting commit from re-triggering this
            # same workflow on the push trigger below.
            git commit -m "chore(notion-sync): pull $(date -u +%FT%TZ) [skip ci]"
            git push
          else
            echo "no content changes"
          fi

      # ─── Propagate Notion edits to feature branches ───────────────
      # Notion edits landed on main above. Feature branches cut before
      # the edit came in are now stale — and agents that are already
      # running on those branches won't see the update until merge.
      # \`pull-branches\` iterates every \`feature/*\` branch, re-runs the
      # pull with \`--prefer-local\` (so any FDD/TDD/Documentation/test-
      # report edits the agent already made on the branch are kept
      # untouched on conflict), and commits + pushes the resulting
      # .volt/ delta on each branch. Skipped for the push trigger
      # because that path is repo → Notion, not Notion → repo.
      - name: Propagate Notion edits to feature branches
        if: github.event_name != 'push'
        env:
          NOTION_TOKEN: \${{ secrets.NOTION_TOKEN }}
        run: |
          git config user.name  "volt-notion-sync[bot]"
          git config user.email "volt-notion-sync[bot]@users.noreply.github.com"
          npx --yes github:Volt-Technologies/Volt-Notion-Sync pull-branches \\
            --repo "$GITHUB_WORKSPACE" \\
            --pattern 'feature/*' \\
            --message "chore(notion-sync): propagate Notion edits [skip ci]"

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
          git add -A
          git reset HEAD '.volt/.sync-state.json' >/dev/null 2>&1 || true
          if ! git diff --cached --quiet; then
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
          git add -A
          git reset HEAD '.volt/.sync-state.json' >/dev/null 2>&1 || true
          if git diff --cached --quiet; then
            echo "no pr-mode content changes"
            exit 0
          fi
          BRANCH="notion-sync/pr-$(date -u +%Y%m%d-%H%M%S)"
          git checkout -b "$BRANCH"
          git commit -m "chore(notion-sync): pr-mode pull $(date -u +%FT%TZ) [skip ci]"
          git push -u origin "$BRANCH"
          gh pr create \\
            --base main \\
            --head "$BRANCH" \\
            --title "Notion sync (review): $(date -u +%FT%TZ)" \\
            --body "Automated PR for review-required Notion mappings (commitStrategy: pr)."
`;

// Slim seed config: only what each project must specify itself. The
// CLI's STANDARD_MAPPINGS supply Process Flows, Waterfall Tasks, Project
// Definition, and Meetings (all optional) — repos override individually
// or skip with \`disabled: true\`. To add custom mappings the standard
// set doesn't cover, append to the empty mappings list. To debug what
// actually runs, use \`volt-notion-sync inspect --resolve\`.
export const QUICKSTART_TEMPLATE_YAML = `version: 1

notion:
  teamspaceId: REPLACE_WITH_TEAMSPACE_UUID
  rootPageId:  REPLACE_WITH_PROJECT_HOME_PAGE_UUID

# Run a 3-way \`git merge-file\` when the same page changed in both
# Notion and the repo since the last sync. Non-overlapping edits from
# each side are preserved; overlapping edits resolve to Notion's
# version. The alternative ('abort') aborts the GitHub Action when
# anything conflicts, which blocks the sync until a human intervenes.
conflictPolicy: merge-prefer-notion

# Standard mappings (Process Flows, Waterfall Tasks, Project Definition,
# Meetings) come from the CLI — see STANDARD_MAPPINGS in
# Volt-Notion-Sync/src/config/defaults.ts. To override one, list it here
# with the same \`notion:\` name and any fields you want to change. To
# skip one entirely, list it with \`disabled: true\`. Set
# \`useStandardMappings: false\` at the top level for full opt-out.
mappings: []

# Repo-specific notionIgnore/localIgnore are CONCATENATED with the
# CLI's STANDARD_NOTION_IGNORE / STANDARD_LOCAL_IGNORE — no need to
# repeat the standard entries.
notionIgnore: []
localIgnore: []
`;

