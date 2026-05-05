import type { Client } from '@notionhq/client';
import type { Config, Mapping, ResolvedMapping } from '../config/types.js';
import { collectNamedChildren, fetchPageNode, walkPageTree } from '../notion/walker.js';
import type { NamedChildBlock } from '../notion/walker.js';

interface RawDatabaseLite {
  id: string;
  title?: Array<{ plain_text?: string }>;
  data_sources?: Array<{ id: string }>;
}

export class MappingResolutionError extends Error {
  constructor(public readonly mapping: Mapping, message: string) {
    super(message);
    this.name = 'MappingResolutionError';
  }
}

type NamedChild = NamedChildBlock;

export async function resolveMappings(
  client: Client,
  config: Config,
): Promise<ResolvedMapping[]> {
  const needsRootLookup = config.mappings.some((m) => !m.notionId && m.notion);
  const rootChildren = needsRootLookup
    ? await collectNamedChildren(client, config.notion.rootPageId)
    : [];
  // Canonical DB scan happens lazily — only when at least one DB-typed
  // mapping needs resolution and isn't already a direct child of the
  // root page. Quickstart projects hide canonical DBs under
  // Settings → Databases, so we walk the project tree once and build
  // a name → id lookup of every reachable DB whose data_sources is
  // non-empty (i.e. the integration can actually query it).
  let canonicalDbsByName: Map<string, string> | undefined;
  const ensureCanonicalDbs = async (): Promise<Map<string, string>> => {
    if (canonicalDbsByName) return canonicalDbsByName;
    canonicalDbsByName = await scanCanonicalDatabases(client, config.notion.rootPageId);
    return canonicalDbsByName;
  };

  const resolved: ResolvedMapping[] = [];

  for (const m of config.mappings) {
    const direction = m.direction ?? config.defaultDirection;
    const commitStrategy = m.commitStrategy ?? config.commitStrategy;

    let id: string | undefined = m.notionId;
    if (!id && m.notion) {
      const wantedKind = m.type === 'database' ? 'database' : 'page';
      const match = rootChildren.find(
        (c) => c.title.trim().toLowerCase() === m.notion!.trim().toLowerCase() && c.kind === wantedKind,
      );
      if (match) {
        id = match.id;
      } else if (wantedKind === 'database') {
        // Fall back to a deep tree scan — Quickstart canonicals live
        // under Settings → Databases, not at the root.
        const dbs = await ensureCanonicalDbs();
        id = dbs.get(m.notion.trim().toLowerCase());
      }

      if (!id) {
        if (m.optional) continue;
        throw new MappingResolutionError(
          m,
          `Could not find ${m.type} named "${m.notion}" under root page ${config.notion.rootPageId}. ` +
            `Mark mapping as optional, fix the name, or set notionId directly.`,
        );
      }
    }

    if (!id) {
      throw new MappingResolutionError(m, 'Mapping resolved to no id');
    }
    if (!m.local) {
      // Defensive: load.ts/mergeMappings should ensure every mapping has
      // a local path before we get here.
      throw new MappingResolutionError(m, 'Mapping has no local path after merge');
    }

    resolved.push({
      ...m,
      local: m.local,
      resolvedNotionId: id,
      resolvedDirection: direction,
      resolvedCommitStrategy: commitStrategy,
    });
  }
  return resolved;
}

// Walk the entire page tree under rootPageId, collect every canonical
// database (one whose data_sources array is non-empty — meaning the
// integration can actually query it). Returns a name → database-id map
// keyed by lowercase title. Inline reference blocks with empty
// data_sources are filtered out so the lookup always points at a
// queryable canonical.
async function scanCanonicalDatabases(
  client: Client,
  rootPageId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  const nodes = await walkPageTree(client, rootPageId);
  const c = client as unknown as { request: (args: unknown) => Promise<unknown> };
  for (const node of nodes) {
    for (const dbId of node.childDatabaseIds) {
      if (seen.has(dbId)) continue;
      seen.add(dbId);
      try {
        const db = (await c.request({
          path: `databases/${dbId}`,
          method: 'get',
        })) as RawDatabaseLite;
        const hasDataSource = (db.data_sources?.length ?? 0) > 0;
        const title = db.title?.[0]?.plain_text?.trim();
        if (hasDataSource && title) {
          const key = title.toLowerCase();
          // First win — if multiple canonicals share a name (rare),
          // keep the first encountered. User can override via notionId.
          if (!out.has(key)) out.set(key, dbId);
        }
      } catch {
        // Inaccessible / archived — skip silently
      }
    }
  }
  return out;
}

export async function inspectRoot(client: Client, rootPageId: string): Promise<{
  rootTitle: string;
  children: NamedChild[];
}> {
  const root = await fetchPageNode(client, rootPageId, []);
  const children = await collectNamedChildren(client, rootPageId);
  return { rootTitle: root.title, children };
}
