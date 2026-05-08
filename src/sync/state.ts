import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SyncStateEntry {
  notionId: string;
  localPath: string;
  notionLastEditedTime: string;
  contentHash: string;
  // Full rendered file content from the last successful sync. Required
  // by the merge-prefer-notion conflict policy as the common ancestor
  // for `git merge-file`. Optional so state files written by older CLI
  // versions still load — a missing baseContent forces notion-wins on
  // that entry until the next pull repopulates it.
  baseContent?: string;
}

export interface SyncState {
  version: 1;
  lastPullAt: string | null;
  lastPushAt: string | null;
  entries: Record<string, SyncStateEntry>;
}

export const STATE_FILENAME = '.sync-state.json';

export function emptyState(): SyncState {
  return { version: 1, lastPullAt: null, lastPushAt: null, entries: {} };
}

export async function loadState(repoRoot: string): Promise<SyncState> {
  const p = path.join(repoRoot, '.volt', STATE_FILENAME);
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as SyncState;
    if (parsed.version !== 1) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

export async function saveState(repoRoot: string, state: SyncState): Promise<void> {
  const dir = path.join(repoRoot, '.volt');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, STATE_FILENAME);
  await writeFile(p, JSON.stringify(state, null, 2), 'utf-8');
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
