import path from 'node:path';
import { rm } from 'node:fs/promises';
import { APIResponseError, type Client } from '@notionhq/client';
import type { Config, ResolvedMapping } from '../config/types.js';
import { loadState, saveState } from './state.js';
import { pull, type PullResult } from './pull.js';
import { normalizeId } from '../notion/client.js';

// Notion webhook entity types relevant to us. We use 'page' as the
// conservative default when the trigger didn't tell us a type.
export type EntityType = 'page' | 'database' | 'data_source' | 'comment' | 'block';

export interface EntityPullOptions {
  client: Client;
  repoRoot: string;
  config: Config;
  mappings: ResolvedMapping[];
  entityId: string;
  entityType?: EntityType;
  // Notion webhook event type — e.g. "page.content_updated",
  // "page.deleted", "data_source.schema_updated". Optional; without it
  // we fall back to a conservative "fetch the entity and figure out"
  // path that handles new pages, edits, and 404s identically.
  eventType?: string;
  log?: (msg: string) => void;
}

export interface EntityPullResult {
  // What we ended up doing:
  //   mapping-pull        — per-mapping full pull of the owning mapping
  //   deleted             — page.deleted / data_source.deleted: removed local file + state entry
  //   ignored             — event was in the ignore-list (comments, locks, db ops)
  //   no-mapping-match    — couldn't trace the entity to any configured mapping
  action: 'mapping-pull' | 'deleted' | 'ignored' | 'no-mapping-match';
  notionId: string;
  mappingLocal?: string;
  localPath?: string;
  pull?: PullResult;
}

// Event types that don't translate to any markdown change. We exit
// early without any API calls — comments are noisy in particular.
const IGNORE_EVENTS = new Set<string>([
  'page.locked',
  'page.unlocked',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'database.created',
  'database.moved',
  'database.deleted',
  'database.undeleted',
  'data_source.moved',
]);

function shouldIgnoreEvent(eventType: string | undefined): boolean {
  if (!eventType) return false;
  return IGNORE_EVENTS.has(eventType);
}

function isDeleteEvent(eventType: string | undefined): boolean {
  return eventType === 'page.deleted' || eventType === 'data_source.deleted';
}

export async function pullEntity(opts: EntityPullOptions): Promise<EntityPullResult> {
  const log = opts.log ?? (() => {});

  if (shouldIgnoreEvent(opts.eventType)) {
    log(`event "${opts.eventType}" → ignored (no markdown impact)`);
    return { action: 'ignored', notionId: opts.entityId };
  }

  if (isDeleteEvent(opts.eventType)) {
    return await deleteLocal(opts, log);
  }

  const owning = await walkParentsToMapping(
    opts.client,
    opts.entityId,
    opts.entityType ?? 'page',
    opts.mappings,
  );
  if (!owning) {
    log(`entity ${opts.entityId} doesn't belong to any configured mapping → no-op`);
    return { action: 'no-mapping-match', notionId: opts.entityId };
  }

  const mappingName =
    owning.mapping.notion ?? owning.mapping.notionId ?? owning.mapping.local;
  log(`entity ${opts.entityId} → mapping "${mappingName}"`);

  // Snapshot lastPullAt — pull() bumps it on every run, but an entity
  // pull only reconciles one mapping, not all of Notion. The 6h cron
  // is the authoritative "everything is in sync" stamp.
  const stateBefore = await loadState(opts.repoRoot);
  const lastPullAtBefore = stateBefore.lastPullAt;

  const result = await pull({
    client: opts.client,
    repoRoot: opts.repoRoot,
    config: opts.config,
    mappings: [owning.mapping],
    log,
  });

  const stateAfter = await loadState(opts.repoRoot);
  if (stateAfter.lastPullAt !== lastPullAtBefore) {
    stateAfter.lastPullAt = lastPullAtBefore;
    await saveState(opts.repoRoot, stateAfter);
  }

  return {
    action: 'mapping-pull',
    notionId: opts.entityId,
    mappingLocal: owning.mapping.local,
    pull: result,
  };
}

async function deleteLocal(
  opts: EntityPullOptions,
  log: (m: string) => void,
): Promise<EntityPullResult> {
  const state = await loadState(opts.repoRoot);
  const entry = state.entries[opts.entityId];
  if (!entry) {
    log(`delete event for unknown entity ${opts.entityId} → no-op`);
    return { action: 'ignored', notionId: opts.entityId };
  }
  const full = path.join(opts.repoRoot, '.volt', entry.localPath);
  try {
    await rm(full, { force: true });
    log(`deleted ${entry.localPath}`);
  } catch (err) {
    log(`delete of ${entry.localPath} failed: ${(err as Error).message}`);
  }
  delete state.entries[opts.entityId];
  await saveState(opts.repoRoot, state);
  return { action: 'deleted', notionId: opts.entityId, localPath: entry.localPath };
}

interface OwningMapping {
  mapping: ResolvedMapping;
}

// Walk the entity's parent chain until we hit a node whose normalized
// id matches a configured mapping's resolvedNotionId. Capped at 16
// hops as a safety belt against pathological structures.
async function walkParentsToMapping(
  client: Client,
  entityId: string,
  entityType: EntityType,
  mappings: ResolvedMapping[],
): Promise<OwningMapping | null> {
  const byId = new Map<string, ResolvedMapping>();
  for (const m of mappings) {
    byId.set(normalizeId(m.resolvedNotionId), m);
  }

  let currentId = normalizeId(entityId);
  let currentType: EntityType = entityType;

  for (let step = 0; step < 16; step += 1) {
    const hit = byId.get(currentId);
    if (hit) return { mapping: hit };

    const parent = await fetchParent(client, currentId, currentType);
    if (!parent) return null;
    currentId = normalizeId(parent.id);
    currentType = parent.type;
  }
  return null;
}

interface ParentRef {
  id: string;
  type: EntityType;
}

interface RawParent {
  type: string;
  page_id?: string;
  database_id?: string;
  data_source_id?: string;
  block_id?: string;
}

async function fetchParent(
  client: Client,
  id: string,
  type: EntityType,
): Promise<ParentRef | null> {
  const c = client as unknown as { request: (args: unknown) => Promise<unknown> };
  try {
    if (type === 'page' || type === 'block') {
      const page = (await client.pages.retrieve({ page_id: id })) as unknown as {
        parent?: RawParent;
      };
      return parentToRef(page.parent);
    }
    if (type === 'database') {
      const db = (await c.request({ path: `databases/${id}`, method: 'get' })) as {
        parent?: RawParent;
      };
      return parentToRef(db.parent);
    }
    if (type === 'data_source') {
      const ds = (await c.request({ path: `data_sources/${id}`, method: 'get' })) as {
        parent?: RawParent;
      };
      return parentToRef(ds.parent);
    }
    return null;
  } catch (err) {
    if (err instanceof APIResponseError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

function parentToRef(parent: RawParent | undefined): ParentRef | null {
  if (!parent) return null;
  if (parent.type === 'page_id' && parent.page_id) {
    return { id: parent.page_id, type: 'page' };
  }
  if (parent.type === 'database_id' && parent.database_id) {
    return { id: parent.database_id, type: 'database' };
  }
  if (parent.type === 'data_source_id' && parent.data_source_id) {
    return { id: parent.data_source_id, type: 'data_source' };
  }
  if (parent.type === 'block_id' && parent.block_id) {
    // A page hosted inside a layout block (column/synced/toggle). We
    // don't try to climb out of the block here — the parent-of-block
    // resolution would need blocks.retrieve and the typical Quickstart
    // layout doesn't put mapping roots under blocks anyway. The 6h
    // cron catches anything we miss.
    return null;
  }
  // workspace, or unknown — stop walking.
  return null;
}
