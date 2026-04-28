import { mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { Client } from '@notionhq/client';
import type { Config, ResolvedMapping } from '../config/types.js';
import { walkPageTree, type NotionPageNode } from '../notion/walker.js';
import { pageBlocksToMarkdown, slugify } from '../notion/blocksToMarkdown.js';
import { exportDatabase, type DatabaseExport, type NormalizedRow } from '../notion/database.js';
import { isIgnoredNotion } from '../mapping/glob.js';
import { hashContent, loadState, saveState, type SyncState } from './state.js';
import { detectConflicts, applyConflictPolicy, formatConflicts, type Conflict } from './conflict.js';

export interface PullOptions {
  client: Client;
  repoRoot: string;
  config: Config;
  mappings: ResolvedMapping[];
  log?: (msg: string) => void;
}

export interface PullResult {
  pagesWritten: number;
  databasesWritten: number;
  rowsWritten: number;
  filesDeleted: number;
  skipped: number;
  conflicts: Conflict[];
}

export async function pull(opts: PullOptions): Promise<PullResult> {
  const log = opts.log ?? (() => {});
  const result: PullResult = {
    pagesWritten: 0,
    databasesWritten: 0,
    rowsWritten: 0,
    filesDeleted: 0,
    skipped: 0,
    conflicts: [],
  };

  const state = await loadState(opts.repoRoot);
  const conflicts = await detectConflicts({
    client: opts.client,
    repoRoot: opts.repoRoot,
    state,
    mappings: opts.mappings,
  });
  const { aborted } = applyConflictPolicy(opts.config.conflictPolicy, conflicts);
  if (aborted.length > 0) {
    log(`conflict: ${aborted.length} entries — policy=abort`);
    log(formatConflicts(aborted));
    result.conflicts = aborted;
    throw new Error(`Aborting pull due to ${aborted.length} conflict(s):\n${formatConflicts(aborted)}`);
  }
  result.conflicts = conflicts;

  const skipIds = new Set(
    opts.config.conflictPolicy === 'github-wins' ? conflicts.map((c) => c.notionId) : [],
  );
  const writtenPaths = new Set<string>();

  for (const mapping of opts.mappings) {
    if (mapping.resolvedDirection === 'push') {
      log(`skip ${mapping.local} (direction: push)`);
      result.skipped += 1;
      continue;
    }
    if (mapping.type === 'database') {
      log(`pull database: ${mapping.notion ?? mapping.notionId} → ${mapping.local}`);
      const dbResult = await pullDatabase(opts, mapping, state, writtenPaths, skipIds);
      result.databasesWritten += 1;
      result.rowsWritten += dbResult.rowsWritten;
    } else {
      log(`pull page tree: ${mapping.notion ?? mapping.notionId} → ${mapping.local}`);
      const pageResult = await pullPageTree(opts, mapping, state, writtenPaths, skipIds);
      result.pagesWritten += pageResult.pagesWritten;
    }
  }

  result.filesDeleted = await pruneStale(opts.repoRoot, opts.mappings, writtenPaths, log);

  state.lastPullAt = new Date().toISOString();
  await saveState(opts.repoRoot, state);
  return result;
}

async function pullPageTree(
  opts: PullOptions,
  mapping: ResolvedMapping,
  state: SyncState,
  writtenPaths: Set<string>,
  skipIds: Set<string>,
): Promise<{ pagesWritten: number }> {
  const log = opts.log ?? (() => {});
  let pagesWritten = 0;

  const nodes = await walkPageTree(opts.client, mapping.resolvedNotionId, {
    shouldDescend: (node) => !isIgnoredNotion([...node.parentPath, node.title], opts.config.notionIgnore),
  });

  for (const node of nodes) {
    const fullPath = [...node.parentPath, node.title];
    if (isIgnoredNotion(fullPath, opts.config.notionIgnore)) continue;
    if (skipIds.has(node.id)) continue;

    const isRootOfMapping = node.id === mapping.resolvedNotionId;
    const relSegments = isRootOfMapping
      ? ['index']
      : [...node.parentPath.slice(1).map(slugify), slugify(node.title), 'index'];
    const fileRel = path.posix.join(mapping.local, ...relSegments) + '.md';
    const filePath = path.join(opts.repoRoot, '.volt', fileRel);

    const md = await pageBlocksToMarkdown(opts.client, node.id);
    const content = renderMarkdownFile(opts.config, node, md);
    await writeFileEnsured(filePath, content);
    writtenPaths.add(path.normalize(filePath));

    state.entries[node.id] = {
      notionId: node.id,
      localPath: fileRel,
      notionLastEditedTime: node.lastEditedTime,
      contentHash: hashContent(content),
    };

    pagesWritten += 1;
    log(`  page: ${fileRel}`);
  }
  return { pagesWritten };
}

async function pullDatabase(
  opts: PullOptions,
  mapping: ResolvedMapping,
  state: SyncState,
  writtenPaths: Set<string>,
  skipIds: Set<string>,
): Promise<{ rowsWritten: number }> {
  const log = opts.log ?? (() => {});
  const exp: DatabaseExport = await exportDatabase(opts.client, mapping.resolvedNotionId);

  const indexPath = path.posix.join(mapping.local, '_index.json');
  const indexFull = path.join(opts.repoRoot, '.volt', indexPath);
  const indexContent = JSON.stringify(
    {
      databaseId: exp.databaseId,
      dataSourceId: exp.dataSourceId,
      schema: exp.schema,
      rowCount: exp.rows.length,
    },
    null,
    2,
  );
  await writeFileEnsured(indexFull, indexContent);
  writtenPaths.add(path.normalize(indexFull));

  let rowsWritten = 0;
  for (const row of exp.rows) {
    if (isIgnoredNotion([row.title], opts.config.notionIgnore)) continue;
    if (skipIds.has(row.id)) continue;
    const fileRel = path.posix.join(mapping.local, slugify(row.title || row.id) + '.md');
    const filePath = path.join(opts.repoRoot, '.volt', fileRel);
    const content = renderRowMarkdown(opts.config, row, exp);
    await writeFileEnsured(filePath, content);
    writtenPaths.add(path.normalize(filePath));

    state.entries[row.id] = {
      notionId: row.id,
      localPath: fileRel,
      notionLastEditedTime: row.lastEditedTime,
      contentHash: hashContent(content),
    };
    rowsWritten += 1;
  }
  log(`  database rows: ${rowsWritten}`);
  return { rowsWritten };
}

function renderMarkdownFile(config: Config, node: NotionPageNode, body: string): string {
  if (!config.markdown.frontmatter) return body;
  const fm = {
    notion_id: node.id,
    notion_url: node.url,
    last_edited_time: node.lastEditedTime,
    title: node.title,
  };
  return `---\n${YAML.stringify(fm).trimEnd()}\n---\n\n# ${node.title}\n\n${body}`;
}

function renderRowMarkdown(config: Config, row: NormalizedRow, exp: DatabaseExport): string {
  const props = row.properties;
  const body = Object.entries(props)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `- **${k}**: ${formatValue(v)}`)
    .join('\n');
  if (!config.markdown.frontmatter) return `# ${row.title}\n\n${body}\n`;
  const fm = {
    notion_id: row.id,
    notion_url: row.url,
    last_edited_time: row.lastEditedTime,
    title: row.title,
    data_source_id: exp.dataSourceId,
    properties: props,
  };
  return `---\n${YAML.stringify(fm).trimEnd()}\n---\n\n# ${row.title}\n\n${body}\n`;
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  return String(v);
}

async function writeFileEnsured(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

async function pruneStale(
  repoRoot: string,
  mappings: ResolvedMapping[],
  writtenPaths: Set<string>,
  log: (msg: string) => void,
): Promise<number> {
  let deleted = 0;
  for (const mapping of mappings) {
    if (mapping.resolvedDirection === 'push') continue;
    const root = path.join(repoRoot, '.volt', mapping.local);
    try {
      const files = await listFilesRecursive(root);
      for (const f of files) {
        const norm = path.normalize(f);
        if (writtenPaths.has(norm)) continue;
        const base = path.basename(f);
        if (base === '.gitkeep' || base === '_index.json') continue;
        if (!f.endsWith('.md')) continue;
        await rm(f, { force: true });
        log(`  pruned: ${path.relative(repoRoot, f)}`);
        deleted += 1;
      }
    } catch {
      // Mapping folder doesn't exist yet — nothing to prune
    }
  }
  return deleted;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir);
  for (const name of entries) {
    const full = path.join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}
