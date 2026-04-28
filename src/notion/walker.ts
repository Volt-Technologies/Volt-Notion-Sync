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

async function listChildPageIds(client: Client, pageId: string): Promise<string[]> {
  const blocks = await listChildBlocks(client, pageId);
  const ids: string[] = [];
  for (const b of blocks) {
    if (b.type === 'child_page' && !b.archived && !b.in_trash) {
      ids.push(b.id);
    }
  }
  return ids;
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
