import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { Client } from '@notionhq/client';
import type { Config, ResolvedMapping } from '../config/types.js';
import { listLocalFiles, type LocalFile } from '../markdown/walker.js';
import { parseMarkdownFile } from '../markdown/parse.js';
import { markdownToBlocks } from '../markdown/toBlocks.js';
import { listChildBlocks } from '../notion/walker.js';
import { hashContent, loadState, saveState, type SyncState } from './state.js';

export interface PushOptions {
  client: Client;
  repoRoot: string;
  config: Config;
  mappings: ResolvedMapping[];
  log?: (msg: string) => void;
}

export interface PushResult {
  pagesUpdated: number;
  pagesCreated: number;
  rowsUpdated: number;
  rowsCreated: number;
  skipped: number;
}

export async function push(opts: PushOptions): Promise<PushResult> {
  const log = opts.log ?? (() => {});
  const result: PushResult = {
    pagesUpdated: 0,
    pagesCreated: 0,
    rowsUpdated: 0,
    rowsCreated: 0,
    skipped: 0,
  };

  const state = await loadState(opts.repoRoot);
  const pushable = opts.mappings.filter((m) => m.resolvedDirection !== 'pull');
  const files = await listLocalFiles(opts.repoRoot, pushable, opts.config.localIgnore);

  // Order matters: rows / top-level pages first, then nested children by
  // increasing depth. A child page's parent must already exist (and have
  // a notion_id written back into its frontmatter) before we push the child.
  files.sort((a, b) => fileDepth(a) - fileDepth(b));

  for (const file of files) {
    const parsed = await parseMarkdownFile(file.absPath);
    // Skip files whose content matches what we recorded after the last sync.
    if (parsed.notionId) {
      const recorded = state.entries[parsed.notionId];
      const currentHash = hashContent(await readFile(file.absPath, 'utf-8'));
      if (recorded && recorded.contentHash === currentHash) {
        log(`  unchanged, skip: ${file.relPath}`);
        result.skipped += 1;
        continue;
      }
    }
    const depth = fileDepth(file);
    if (file.mapping.type === 'database') {
      if (depth === 1) {
        await pushDatabaseRow(opts, file, parsed, state, result, log);
      } else {
        await pushRowChildPage(opts, file, parsed, state, result, log);
      }
    } else {
      await pushPage(opts, file, parsed, state, result, log);
    }
  }

  state.lastPushAt = new Date().toISOString();
  await saveState(opts.repoRoot, state);
  return result;
}

// Depth of `file.relPath` relative to its mapping. A file directly inside
// the mapping folder is depth 1; one sub-directory deeper is 2; etc. Used
// to distinguish database rows (1) from row child pages (>=2).
function fileDepth(file: LocalFile): number {
  const mappingPrefix = file.mapping.local.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  const tail = file.relPath.startsWith(mappingPrefix) ? file.relPath.slice(mappingPrefix.length) : file.relPath;
  return tail.split('/').length;
}

async function pushPage(
  opts: PushOptions,
  file: LocalFile,
  parsed: Awaited<ReturnType<typeof parseMarkdownFile>>,
  state: SyncState,
  result: PushResult,
  log: (m: string) => void,
): Promise<void> {
  const blocks = markdownToBlocks(parsed.body);
  const title = parsed.title || path.basename(file.absPath, '.md');

  if (parsed.notionId) {
    await replacePageBlocks(opts.client, parsed.notionId, blocks);
    await opts.client.pages.update({
      page_id: parsed.notionId,
      properties: titleProperty(title) as never,
    });
    result.pagesUpdated += 1;
    log(`  page updated: ${file.relPath}`);
    const onDisk = await readFile(file.absPath, 'utf-8');
    state.entries[parsed.notionId] = {
      notionId: parsed.notionId,
      localPath: file.relPath,
      notionLastEditedTime: new Date().toISOString(),
      contentHash: hashContent(onDisk),
      baseContent: onDisk,
    };
  } else {
    const created = await opts.client.pages.create({
      parent: { page_id: file.mapping.resolvedNotionId },
      properties: titleProperty(title) as never,
      children: blocks as never,
    });
    const newId = (created as { id: string }).id;
    await writeBackId(file.absPath, newId, (created as { url?: string }).url ?? '');
    result.pagesCreated += 1;
    log(`  page created: ${file.relPath} → ${newId}`);
    const onDisk = await readFile(file.absPath, 'utf-8');
    state.entries[newId] = {
      notionId: newId,
      localPath: file.relPath,
      notionLastEditedTime: new Date().toISOString(),
      contentHash: hashContent(onDisk),
      baseContent: onDisk,
    };
  }
}

async function pushDatabaseRow(
  opts: PushOptions,
  file: LocalFile,
  parsed: Awaited<ReturnType<typeof parseMarkdownFile>>,
  state: SyncState,
  result: PushResult,
  log: (m: string) => void,
): Promise<void> {
  const dataSourceId = parsed.dataSourceId || (await firstDataSourceId(opts.client, file.mapping.resolvedNotionId));
  if (!dataSourceId) {
    log(`  skip ${file.relPath}: no data_source_id`);
    result.skipped += 1;
    return;
  }
  const properties = await buildPropertiesFromFrontmatter(opts.client, dataSourceId, parsed);

  const blocks = markdownToBlocks(parsed.body);

  if (parsed.notionId) {
    await opts.client.pages.update({ page_id: parsed.notionId, properties: properties as never });
    if (blocks.length > 0 || parsed.body.trim()) {
      await replacePageBlocks(opts.client, parsed.notionId, blocks);
    }
    result.rowsUpdated += 1;
    log(`  row updated: ${file.relPath} (${blocks.length} blocks)`);
    const onDisk = await readFile(file.absPath, 'utf-8');
    state.entries[parsed.notionId] = {
      notionId: parsed.notionId,
      localPath: file.relPath,
      notionLastEditedTime: new Date().toISOString(),
      contentHash: hashContent(onDisk),
      baseContent: onDisk,
    };
  } else {
    const c = opts.client as unknown as { request: (a: unknown) => Promise<{ id: string; url?: string }> };
    const created = await c.request({
      path: 'pages',
      method: 'post',
      body: { parent: { data_source_id: dataSourceId }, properties, children: blocks },
    });
    await writeBackId(file.absPath, created.id, created.url ?? '');
    result.rowsCreated += 1;
    log(`  row created: ${file.relPath} → ${created.id} (${blocks.length} blocks)`);
    const onDisk = await readFile(file.absPath, 'utf-8');
    state.entries[created.id] = {
      notionId: created.id,
      localPath: file.relPath,
      notionLastEditedTime: new Date().toISOString(),
      contentHash: hashContent(onDisk),
      baseContent: onDisk,
    };
  }
}

// Pushes a row child page. The parent is identified by a sibling
// "<dir>.md" file at the directory above this one — read its notion_id
// from frontmatter (which the parent's own push step has already written
// back if it was newly created). Child pages have no DB properties, only
// a title; they're regular pages whose parent is another page.
async function pushRowChildPage(
  opts: PushOptions,
  file: LocalFile,
  parsed: Awaited<ReturnType<typeof parseMarkdownFile>>,
  state: SyncState,
  result: PushResult,
  log: (m: string) => void,
): Promise<void> {
  const parentFile = path.join(path.dirname(file.absPath) + '.md');
  let parentId: string | null = null;
  try {
    const parentParsed = await parseMarkdownFile(parentFile);
    parentId = parentParsed.notionId ?? null;
  } catch {
    // Parent file missing — the child is orphaned in the local mirror.
  }
  if (!parentId) {
    log(`  skip ${file.relPath}: parent ${path.relative(opts.repoRoot, parentFile)} has no notion_id`);
    result.skipped += 1;
    return;
  }

  const blocks = markdownToBlocks(parsed.body);
  const title = parsed.title || path.basename(file.absPath, '.md');

  if (parsed.notionId) {
    await replacePageBlocks(opts.client, parsed.notionId, blocks);
    await opts.client.pages.update({
      page_id: parsed.notionId,
      properties: titleProperty(title) as never,
    });
    result.pagesUpdated += 1;
    log(`  child updated: ${file.relPath} (${blocks.length} blocks)`);
    const onDisk = await readFile(file.absPath, 'utf-8');
    state.entries[parsed.notionId] = {
      notionId: parsed.notionId,
      localPath: file.relPath,
      notionLastEditedTime: new Date().toISOString(),
      contentHash: hashContent(onDisk),
      baseContent: onDisk,
    };
  } else {
    const created = await opts.client.pages.create({
      parent: { page_id: parentId },
      properties: titleProperty(title) as never,
      children: blocks as never,
    });
    const newId = (created as { id: string }).id;
    await writeBackId(file.absPath, newId, (created as { url?: string }).url ?? '');
    result.pagesCreated += 1;
    log(`  child created: ${file.relPath} → ${newId} (${blocks.length} blocks)`);
    const onDisk = await readFile(file.absPath, 'utf-8');
    state.entries[newId] = {
      notionId: newId,
      localPath: file.relPath,
      notionLastEditedTime: new Date().toISOString(),
      contentHash: hashContent(onDisk),
      baseContent: onDisk,
    };
  }
}

async function replacePageBlocks(
  client: Client,
  pageId: string,
  blocks: unknown[],
): Promise<void> {
  const existing = await listChildBlocks(client, pageId);
  for (const b of existing) {
    try {
      await client.blocks.delete({ block_id: b.id });
    } catch {
      // tolerate errors on undeletable blocks (e.g., synced or templated)
    }
  }
  for (let i = 0; i < blocks.length; i += 100) {
    const batch = blocks.slice(i, i + 100);
    await client.blocks.children.append({ block_id: pageId, children: batch as never });
  }
}

function titleProperty(title: string): Record<string, unknown> {
  return { title: { title: [{ type: 'text', text: { content: title } }] } };
}

async function firstDataSourceId(client: Client, databaseId: string): Promise<string | null> {
  const db = (await client.databases.retrieve({ database_id: databaseId })) as unknown as {
    data_sources?: Array<{ id: string }>;
  };
  return db.data_sources?.[0]?.id ?? null;
}

async function buildPropertiesFromFrontmatter(
  client: Client,
  dataSourceId: string,
  parsed: { properties: Record<string, unknown> | null; title: string | null },
): Promise<Record<string, unknown>> {
  const c = client as unknown as { request: (a: unknown) => Promise<{ properties: Record<string, { name: string; type: string }> }> };
  const ds = await c.request({ path: `data_sources/${dataSourceId}`, method: 'get' });
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(ds.properties)) {
    const value = parsed.properties?.[name];
    if (value === undefined) continue;
    const built = buildPropertyValue(schema.type, value, parsed.title);
    if (built !== undefined) out[name] = built;
  }
  const hasTitle = Object.values(out).some((v) => Boolean((v as { title?: unknown }).title));
  if (!hasTitle && parsed.title) {
    const titleProp = Object.entries(ds.properties).find(([, s]) => s.type === 'title');
    if (titleProp) {
      const [propName] = titleProp;
      out[propName] = { title: [{ type: 'text', text: { content: parsed.title } }] };
    }
  }
  return out;
}

function buildPropertyValue(type: string, value: unknown, _title: string | null): unknown {
  switch (type) {
    case 'title':
      return { title: [{ type: 'text', text: { content: String(value ?? '') } }] };
    case 'rich_text':
      return { rich_text: [{ type: 'text', text: { content: String(value ?? '') } }] };
    case 'select':
      return value ? { select: { name: String(value) } } : { select: null };
    case 'status':
      return value ? { status: { name: String(value) } } : { status: null };
    case 'multi_select':
      return { multi_select: (Array.isArray(value) ? value : [value]).filter(Boolean).map((v) => ({ name: String(v) })) };
    case 'checkbox':
      return { checkbox: Boolean(value) };
    case 'number':
      return { number: value === null || value === '' ? null : Number(value) };
    case 'url':
      return { url: value ? String(value) : null };
    case 'email':
      return { email: value ? String(value) : null };
    case 'phone_number':
      return { phone_number: value ? String(value) : null };
    case 'date':
      if (!value) return { date: null };
      return { date: { start: toIsoDate(value) } };
    default:
      return undefined;
  }
}

function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}

async function writeBackId(filePath: string, notionId: string, notionUrl: string): Promise<void> {
  const raw = await readFile(filePath, 'utf-8');
  const fmEnd = raw.indexOf('\n---', 4);
  if (!raw.startsWith('---\n') || fmEnd === -1) {
    const fm = `---\n${YAML.stringify({ notion_id: notionId, notion_url: notionUrl }).trimEnd()}\n---\n\n`;
    await writeFile(filePath, fm + raw, 'utf-8');
    return;
  }
  const fmText = raw.slice(4, fmEnd);
  const data = (YAML.parse(fmText) ?? {}) as Record<string, unknown>;
  data.notion_id = notionId;
  if (notionUrl) data.notion_url = notionUrl;
  const newFm = `---\n${YAML.stringify(data).trimEnd()}\n---`;
  const rest = raw.slice(fmEnd + 4);
  await writeFile(filePath, newFm + rest, 'utf-8');
}
