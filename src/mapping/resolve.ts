import type { Client } from '@notionhq/client';
import type { Config, Mapping, ResolvedMapping } from '../config/types.js';
import { collectNamedChildren, fetchPageNode } from '../notion/walker.js';
import type { NamedChildBlock } from '../notion/walker.js';

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
      } else if (m.optional) {
        continue;
      } else {
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

export async function inspectRoot(client: Client, rootPageId: string): Promise<{
  rootTitle: string;
  children: NamedChild[];
}> {
  const root = await fetchPageNode(client, rootPageId, []);
  const children = await collectNamedChildren(client, rootPageId);
  return { rootTitle: root.title, children };
}
