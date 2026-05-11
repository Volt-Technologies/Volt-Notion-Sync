/**
 * Multi-branch pull orchestrator.
 *
 * Why this exists
 * ---------------
 * Notion sync writes to whatever branch is checked out — historically just
 * `main`. But agents work on `feature/<slug>` branches, and a user editing
 * a Notion page after the feature branch was cut will have their edit land
 * on `main` only. The agent never sees it.
 *
 * This module fans the sync out: for each matching branch, check it out,
 * run `pull` with conflict policy `github-wins` (preserve any agent edits
 * already on that branch), commit any `.volt/` deltas, and push. The
 * caller is expected to have run `pull` on `main` first via the normal
 * `pull` command — `pullFeatureBranches` only handles the propagation.
 *
 * Constraints
 * -----------
 * - Working tree must be clean when this runs (we switch branches).
 * - `git` must be on PATH.
 * - Only `.volt/` changes are committed. Stale BC AL edits in the working
 *   tree that survive a branch switch (shouldn't happen on a clean tree)
 *   are not committed.
 * - Push direction (repo → Notion) is intentionally NOT invoked here; see
 *   the `push` CLI command's branch-safety guard. Pushing intermediate
 *   feature-branch state to Notion would clobber other branches' content.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Client } from '@notionhq/client';
import type { Config, ResolvedMapping } from '../config/types.js';
import { pull, type PullResult } from './pull.js';

export interface PullBranchesOptions {
  client: Client;
  repoRoot: string;
  config: Config;
  mappings: ResolvedMapping[];
  /**
   * Glob-style pattern matched against local branch names (after fetch).
   * Default: `feature/*` — the BC extension flow's branch convention.
   */
  pattern?: string;
  /**
   * Run `git fetch --prune` before iterating so we see branches created
   * remotely (e.g. by the platform when a new extension is started).
   */
  fetch?: boolean;
  /**
   * Push the resulting commits back to `origin/<branch>`. Default true —
   * set to false for dry runs / local experimentation.
   */
  push?: boolean;
  /**
   * Commit message for the per-branch sync commit.
   * Default: `chore(notion-sync): propagate Notion edits`.
   */
  commitMessage?: string;
  log?: (msg: string) => void;
}

export interface BranchPullOutcome {
  branch: string;
  /** false when the pull was a no-op (no .volt/ deltas to commit). */
  changed: boolean;
  /** Whether we pushed (false on dry run, or when nothing changed). */
  pushed: boolean;
  pull: PullResult;
}

export interface PullBranchesResult {
  startedFromBranch: string;
  branches: BranchPullOutcome[];
  /** Branches we discovered via pattern but skipped (e.g. couldn't checkout). */
  skipped: Array<{ branch: string; reason: string }>;
}

export async function pullFeatureBranches(opts: PullBranchesOptions): Promise<PullBranchesResult> {
  const log = opts.log ?? (() => {});
  const pattern = opts.pattern ?? 'feature/*';
  const doFetch = opts.fetch ?? true;
  const doPush = opts.push ?? true;
  const commitMessage = opts.commitMessage ?? 'chore(notion-sync): propagate Notion edits';

  // The workflow's main pull step deliberately leaves
  // `.volt/.sync-state.json` unstaged (it doesn't push it — see comments
  // in WORKFLOW_TEMPLATE_YAML). Discard that one file before the
  // clean-tree check so the dirty state-file timestamp doesn't block
  // us. Anything else dirty is operator error and should abort.
  await git(opts.repoRoot, ['checkout', '--', '.volt/.sync-state.json']).catch(() => undefined);

  await assertCleanWorkingTree(opts.repoRoot);
  const startedFromBranch = await currentBranch(opts.repoRoot);

  if (doFetch) {
    log('git fetch --prune');
    await git(opts.repoRoot, ['fetch', '--prune']);
  }

  const branches = await discoverBranches(opts.repoRoot, pattern);
  log(`discovered ${branches.length} branch(es) matching ${pattern}`);

  const outcomes: BranchPullOutcome[] = [];
  const skipped: Array<{ branch: string; reason: string }> = [];

  try {
    for (const branch of branches) {
      try {
        log(`\n→ ${branch}`);
        // `discoverBranches` reads `refs/remotes/origin/<pattern>`, so a
        // matching remote ref is guaranteed. Local tracking may not exist
        // yet (e.g. the platform just created `feature/<slug>` and the CI
        // runner hasn't seen it before) — `-B` creates-or-resets the
        // local branch to match `origin/<branch>`, so we always start
        // from the remote tip rather than a stale local copy.
        await git(opts.repoRoot, ['checkout', '-B', branch, `origin/${branch}`]);

        const pullResult = await pull({
          client: opts.client,
          repoRoot: opts.repoRoot,
          config: opts.config,
          mappings: opts.mappings,
          conflictPolicyOverride: 'github-wins',
          log: (m) => log(`  [pull] ${m}`),
        });

        // Stage all `.volt/` changes, then drop the state-file timestamp
        // so we don't commit a noisy lastPullAt-only delta on every cron
        // tick (matches the main workflow's convention).
        await git(opts.repoRoot, ['add', '--', '.volt']);
        await git(opts.repoRoot, ['reset', 'HEAD', '--', '.volt/.sync-state.json']).catch(() => undefined);
        const staged = await git(opts.repoRoot, ['diff', '--cached', '--name-only']);
        const changed = staged.trim().length > 0;
        let pushed = false;
        if (changed) {
          await git(opts.repoRoot, ['commit', '-m', commitMessage]);
          if (doPush) {
            await git(opts.repoRoot, ['push', 'origin', branch]);
            pushed = true;
          }
          log(`  committed${pushed ? ' (pushed)' : ''}: ${staged.trim().split('\n').length} file(s)`);
        } else {
          log('  no .volt/ content changes');
          // Discard the in-tree state-file edit so the next checkout
          // doesn't trip over a dirty working tree.
          await git(opts.repoRoot, ['checkout', '--', '.volt/.sync-state.json']).catch(() => undefined);
        }

        outcomes.push({ branch, changed, pushed, pull: pullResult });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log(`  ! skipped: ${reason}`);
        skipped.push({ branch, reason });
        // Defensively clear any partial WT state from the failed branch
        // before moving on — checkout below would otherwise complain.
        await git(opts.repoRoot, ['reset', '--hard', 'HEAD']).catch(() => undefined);
      }
    }
  } finally {
    // Always return to the branch we started on.
    await git(opts.repoRoot, ['checkout', startedFromBranch]).catch(() => undefined);
  }

  return { startedFromBranch, branches: outcomes, skipped };
}

// =============================================================================
// git helpers
// =============================================================================

async function git(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repoRoot, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function currentBranch(repoRoot: string): Promise<string> {
  return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

async function assertCleanWorkingTree(repoRoot: string): Promise<void> {
  const out = await git(repoRoot, ['status', '--porcelain']);
  if (out.length > 0) {
    throw new Error(
      'working tree is not clean — commit or stash before running pull-branches:\n' + out,
    );
  }
}

async function discoverBranches(repoRoot: string, pattern: string): Promise<string[]> {
  // Use git's own pattern matcher (refs/remotes/origin/<pattern>) so we
  // also see branches the local clone hasn't tracked yet.
  const remoteRef = `refs/remotes/origin/${pattern}`;
  const out = await git(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)',
    remoteRef,
  ]);
  if (!out) return [];
  // Strip the `origin/` prefix so callers operate on local branch names.
  const branches = out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('origin/') ? s.slice('origin/'.length) : s))
    // Exclude HEAD pointer entries like `origin/HEAD -> origin/main`.
    .filter((s) => s !== 'HEAD');
  return [...new Set(branches)];
}

// Exported only for use by the push-safety guard in the CLI.
export async function getCurrentBranch(repoRoot: string): Promise<string> {
  return currentBranch(path.resolve(repoRoot));
}
