import type { Client } from '@notionhq/client';
import type { Config, Mapping, ResolvedMapping } from '../config/types.js';
import { fetchPageNode, listChildBlocks, extractPageTitle } from '../notion/walker.js';

interface RawBlock {
  id: string;
  type: string;
  child_page?: { title?: string };
  child_database?: { title?: string };
}

export class MappingResolutionError extends Error {
  constructor(public readonly mapping: Mapping, message: string) {
    super(message);
    this.name = 'MappingResolutionError';
  }
}

interface NamedChild {
  id: string;
  title: string;
  kind: 'page' | 'database';
}

export async function resolveMappings(
  client: Client,
  config: Config,
): Promise<ResolvedMapping[]> {
  const rootChildren = await listNamedChildren(client, config.notion.rootPageId);
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

    resolved.push({
      ...m,
      resolvedNotionId: id,
      resolvedDirection: direction,
      resolvedCommitStrategy: commitStrategy,
    });
  }
  return resolved;
}

async function listNamedChildren(client: Client, parentId: string): Promise<NamedChild[]> {
  const blocks = (await listChildBlocks(client, parentId)) as unknown as RawBlock[];
  const out: NamedChild[] = [];
  for (const b of blocks) {
    if (b.type === 'child_page' && b.child_page?.title) {
      out.push({ id: b.id, title: b.child_page.title, kind: 'page' });
    } else if (b.type === 'child_database' && b.child_database?.title) {
      out.push({ id: b.id, title: b.child_database.title, kind: 'database' });
    }
  }
  return out;
}

export async function inspectRoot(client: Client, rootPageId: string): Promise<{
  rootTitle: string;
  children: NamedChild[];
}> {
  const root = await fetchPageNode(client, rootPageId, []);
  const blocks = (await listChildBlocks(client, rootPageId)) as unknown as RawBlock[];
  const children: NamedChild[] = [];
  for (const b of blocks) {
    if (b.type === 'child_page' && b.child_page?.title) {
      children.push({ id: b.id, title: b.child_page.title, kind: 'page' });
    } else if (b.type === 'child_database' && b.child_database?.title) {
      children.push({ id: b.id, title: b.child_database.title, kind: 'database' });
    }
  }
  return { rootTitle: root.title, children };
}
