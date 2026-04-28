import { readFile } from 'node:fs/promises';
import type { Client } from '@notionhq/client';
import type { ConflictPolicy, ResolvedMapping } from '../config/types.js';
import { fetchPage } from '../notion/walker.js';
import { hashContent, type SyncState } from './state.js';

export interface Conflict {
  notionId: string;
  localPath: string;
  reason: 'both-changed' | 'missing-locally' | 'missing-remotely';
  mapping: ResolvedMapping;
}

export interface ConflictDetectionInput {
  client: Client;
  repoRoot: string;
  state: SyncState;
  mappings: ResolvedMapping[];
}

export async function detectConflicts(input: ConflictDetectionInput): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  for (const [notionId, entry] of Object.entries(input.state.entries)) {
    const mapping = input.mappings.find((m) => entry.localPath.startsWith(m.local + '/'));
    if (!mapping) continue;

    let localChanged = false;
    try {
      const raw = await readFile(`${input.repoRoot}/.volt/${entry.localPath}`, 'utf-8');
      localChanged = hashContent(raw) !== entry.contentHash;
    } catch {
      conflicts.push({ notionId, localPath: entry.localPath, reason: 'missing-locally', mapping });
      continue;
    }

    let remoteChanged = false;
    let remoteMissing = false;
    try {
      const page = await fetchPage(input.client, notionId);
      remoteChanged = page.last_edited_time !== entry.notionLastEditedTime;
    } catch {
      remoteMissing = true;
    }

    if (remoteMissing) {
      conflicts.push({ notionId, localPath: entry.localPath, reason: 'missing-remotely', mapping });
    } else if (localChanged && remoteChanged) {
      conflicts.push({ notionId, localPath: entry.localPath, reason: 'both-changed', mapping });
    }
  }
  return conflicts;
}

export function applyConflictPolicy(
  policy: ConflictPolicy,
  conflicts: Conflict[],
): { proceed: Conflict[]; aborted: Conflict[] } {
  if (conflicts.length === 0) return { proceed: [], aborted: [] };
  if (policy === 'abort') return { proceed: [], aborted: conflicts };
  return { proceed: conflicts, aborted: [] };
}

export function formatConflicts(conflicts: Conflict[]): string {
  return conflicts.map((c) => `  ${c.reason} :: ${c.localPath} (${c.notionId})`).join('\n');
}
