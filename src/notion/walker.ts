import type { Client } from '@notionhq/client';

export interface NotionPageNode {
  id: string;
  title: string;
  parentPath: string[];
  lastEditedTime: string;
  url: string;
  archived: boolean;
  childPageIds: string[];
  rawProperties: Record<string, unknown>;
  icon: unknown;
}

interface RawPage {
  id: string;
  url?: string;
  archived?: boolean;
  in_trash?: boolean;
  last_edited_time: string;
  icon?: unknown;
  properties?: Record<string, RawProp>;
}

interface RawProp {
  id: string;
  type: string;
  title?: Array<{ plain_text?: string }>;
}

interface RawBlock {
  id: string;
  type: string;
  has_children?: boolean;
  child_page?: { title?: string };
  child_database?: { title?: string };
  archived?: boolean;
  in_trash?: boolean;
}

export function extractPageTitle(properties: Record<string, RawProp> | undefined): string {
  if (!properties) return 'Untitled';
  for (const prop of Object.values(properties)) {
    if (prop.type === 'title' && Array.isArray(prop.title)) {
      const text = prop.title.map((t) => t.plain_text ?? '').join('').trim();
      if (text) return text;
    }
  }
  return 'Untitled';
}

export async function fetchPage(client: Client, pageId: string): Promise<RawPage> {
  return (await client.pages.retrieve({ page_id: pageId })) as unknown as RawPage;
}

export async function listChildBlocks(client: Client, blockId: string): Promise<RawBlock[]> {
  const out: RawBlock[] = [];
  let cursor: string | undefined;
  do {
    const res = (await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    })) as unknown as { results: RawBlock[]; has_more: boolean; next_cursor: string | null };
    out.push(...res.results);
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

// Quickstart Project Home pages organise child pages inside callouts /
// columns / toggles for visual layout. Notion stores those sub-pages as
// child_page blocks whose parent is the container, not the page itself —
// so a flat blocks.children.list against the page misses them. This helper
// descends through layout containers to surface every child_page /
// child_database the page actually holds.
const RECURSE_INTO_TYPES = new Set([
  'column_list',
  'column',
  'callout',
  'toggle',
  'synced_block',
]);

export interface NamedChildBlock {
  id: string;
  title: string;
  kind: 'page' | 'database';
}

export async function collectNamedChildren(
  client: Client,
  parentBlockId: string,
  maxDepth = 8,
): Promise<NamedChildBlock[]> {
  const out: NamedChildBlock[] = [];
  const seen = new Set<string>();

  async function visit(blockId: string, depth: number): Promise<void> {
    if (depth > maxDepth || seen.has(blockId)) return;
    seen.add(blockId);
    const blocks = await listChildBlocks(client, blockId);
    for (const b of blocks) {
      if (b.archived || b.in_trash) continue;
      if (b.type === 'child_page' && b.child_page?.title) {
        out.push({ id: b.id, title: b.child_page.title, kind: 'page' });
      } else if (b.type === 'child_database' && b.child_database?.title) {
        out.push({ id: b.id, title: b.child_database.title, kind: 'database' });
      } else if (RECURSE_INTO_TYPES.has(b.type) && b.has_children) {
        await visit(b.id, depth + 1);
      }
    }
  }

  await visit(parentBlockId, 0);
  return out;
}

async function listChildPageIds(client: Client, pageId: string): Promise<string[]> {
  const named = await collectNamedChildren(client, pageId);
  return named.filter((c) => c.kind === 'page').map((c) => c.id);
}

export async function fetchPageNode(
  client: Client,
  pageId: string,
  parentPath: string[],
): Promise<NotionPageNode> {
  const page = await fetchPage(client, pageId);
  const title = extractPageTitle(page.properties);
  const childPageIds = await listChildPageIds(client, pageId);
  return {
    id: page.id,
    title,
    parentPath,
    lastEditedTime: page.last_edited_time,
    url: page.url ?? '',
    archived: Boolean(page.archived || page.in_trash),
    childPageIds,
    rawProperties: page.properties ?? {},
    icon: page.icon,
  };
}

export interface WalkOptions {
  maxDepth?: number;
  onNode?: (node: NotionPageNode) => void;
  shouldDescend?: (node: NotionPageNode) => boolean;
}

export async function walkPageTree(
  client: Client,
  rootPageId: string,
  opts: WalkOptions = {},
): Promise<NotionPageNode[]> {
  const out: NotionPageNode[] = [];
  const maxDepth = opts.maxDepth ?? 32;

  async function visit(pageId: string, parentPath: string[], depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const node = await fetchPageNode(client, pageId, parentPath);
    if (node.archived) return;
    out.push(node);
    opts.onNode?.(node);
    if (opts.shouldDescend && !opts.shouldDescend(node)) return;
    const childPath = [...parentPath, node.title];
    for (const childId of node.childPageIds) {
      await visit(childId, childPath, depth + 1);
    }
  }

  await visit(rootPageId, [], 0);
  return out;
}
