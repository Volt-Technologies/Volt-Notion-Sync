import { mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { Client } from '@notionhq/client';
import type { Config, ResolvedMapping } from '../config/types.js';
import { walkPageTree, type NotionPageNode } from '../notion/walker.js';
import { pageBlocksToMarkdown, slugify } from '../notion/blocksToMarkdown.js';
import { exportDatabase, type DatabaseExport, type NormalizedRow } from '../notion/database.js';
import { isIgnoredNotion, matchesAny } from '../mapping/glob.js';
import { hashContent, loadState, saveState, type SyncState } from './state.js';
import { detectConflicts, applyConflictPolicy, formatConflicts, type Conflict } from './conflict.js';
import { mergePreferNotion } from './merge.js';


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
    // Throwing already prints formatConflicts to stderr; don't double-log.
    throw new Error(
      `Aborting pull due to ${aborted.length} conflict(s):\n${formatConflicts(aborted)}`,
    );
  }
  result.conflicts = conflicts;

  const skipIds = new Set(
    opts.config.conflictPolicy === 'github-wins' ? conflicts.map((c) => c.notionId) : [],
  );
  // Index of both-changed conflicts the merge-prefer-notion path must
  // resolve in-line. Other policies leave this empty so writeWithMerge
  // is a straight passthrough.
  const mergeMap = new Map<string, Conflict>(
    opts.config.conflictPolicy === 'merge-prefer-notion'
      ? conflicts.filter((c) => c.reason === 'both-changed').map((c) => [c.notionId, c])
      : [],
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
      const dbResult = await pullDatabase(opts, mapping, state, writtenPaths, skipIds, mergeMap);
      result.databasesWritten += 1;
      result.rowsWritten += dbResult.rowsWritten;
    } else {
      log(`pull page tree: ${mapping.notion ?? mapping.notionId} → ${mapping.local}`);
      const pageResult = await pullPageTree(opts, mapping, state, writtenPaths, skipIds, mergeMap);
      result.pagesWritten += pageResult.pagesWritten;
    }
  }

  result.filesDeleted = await pruneStale(
    opts.repoRoot,
    opts.mappings,
    writtenPaths,
    opts.config.localIgnore,
    log,
  );

  state.lastPullAt = new Date().toISOString();
  await saveState(opts.repoRoot, state);
  return result;
}

// Resolve a single page/row write under the active conflict policy.
// Returns the actual content that landed on disk (may differ from
// `notionContent` when a 3-way merge succeeded). Callers MUST hash and
// store this returned value, not the input — otherwise the next pull
// will see the stored hash mismatch the file on disk and re-flag the
// entry as locally-changed.
async function writeWithMerge(
  filePath: string,
  notionContent: string,
  notionId: string,
  state: SyncState,
  mergeMap: Map<string, Conflict>,
  log: (m: string) => void,
): Promise<string> {
  const conflict = mergeMap.get(notionId);
  if (!conflict) {
    await writeFileEnsured(filePath, notionContent);
    return notionContent;
  }
  const baseContent = state.entries[notionId]?.baseContent;
  if (baseContent === undefined) {
    // Legacy state from before baseContent was tracked — can't 3-way
    // merge, so honor the policy's stated bias and take Notion. Next
    // pull will populate baseContent and unlock real merges.
    log(`  conflict (no base): ${conflict.localPath} → notion-wins`);
    await writeFileEnsured(filePath, notionContent);
    return notionContent;
  }
  let localContent: string;
  try {
    localContent = await readFile(filePath, 'utf-8');
  } catch {
    // File vanished between conflict detection and write — treat as
    // missing-locally and just write Notion's version.
    await writeFileEnsured(filePath, notionContent);
    return notionContent;
  }
  const result = await mergePreferNotion(notionContent, localContent, baseContent);
  log(`  conflict: ${conflict.localPath} → ${result.clean ? 'merged cleanly' : 'overlap, notion-wins'}`);
  await writeFileEnsured(filePath, result.content);
  return result.content;
}

async function pullPageTree(
  opts: PullOptions,
  mapping: ResolvedMapping,
  state: SyncState,
  writtenPaths: Set<string>,
  skipIds: Set<string>,
  mergeMap: Map<string, Conflict>,
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
      : [...node.parentPath.slice(1).map((s) => slugify(s)), slugify(node.title), 'index'];
    const fileRel = path.posix.join(mapping.local, ...relSegments) + '.md';
    const filePath = path.join(opts.repoRoot, '.volt', fileRel);

    const md = await pageBlocksToMarkdown(opts.client, node.id);
    const notionContent = renderMarkdownFile(opts.config, node, md);
    const written = await writeWithMerge(filePath, notionContent, node.id, state, mergeMap, log);
    writtenPaths.add(path.normalize(filePath));

    state.entries[node.id] = {
      notionId: node.id,
      localPath: fileRel,
      notionLastEditedTime: node.lastEditedTime,
      contentHash: hashContent(written),
      baseContent: written,
    };

    pagesWritten += 1;
    log(`  page: ${fileRel}`);

    // Pages can host inline databases (e.g. a "Extensions" section page
    // whose body is mostly a database widget of EXT-xxxxx tasks). Pull
    // each of those DBs' rows into the page's folder so they land in
    // the repo without requiring an explicit per-DB mapping.
    if (node.childDatabaseIds.length > 0) {
      const pageFolder = path.posix.dirname(fileRel);
      const flat = node.childDatabaseIds.length === 1;
      for (const dbId of node.childDatabaseIds) {
        await pullEmbeddedDatabase(opts, dbId, pageFolder, flat, state, writtenPaths, skipIds, mergeMap);
      }
    }
  }
  return { pagesWritten };
}

// Export a database whose `child_database` block sits inside a page tree
// (and whose rows wouldn't otherwise be pulled). Layout:
//   - 1 DB on the page  → rows flat in pageFolder, schema at _index.json
//   - 2+ DBs on the page → rows in pageFolder/<db-slug>/, schema in there
// Auto-resolve handles the inline-vs-canonical case when data_sources is
// empty. If the canonical can't be uniquely resolved, log + skip rather
// than fail the whole pull — the user can pin notionId via an explicit
// mapping when this matters.
async function pullEmbeddedDatabase(
  opts: PullOptions,
  databaseBlockId: string,
  pageFolder: string,
  flat: boolean,
  state: SyncState,
  writtenPaths: Set<string>,
  skipIds: Set<string>,
  mergeMap: Map<string, Conflict>,
): Promise<void> {
  const log = opts.log ?? (() => {});
  let exp: DatabaseExport;
  try {
    exp = await exportDatabase(opts.client, databaseBlockId);
  } catch (err) {
    log(`    embedded db ${databaseBlockId}: skipped (${(err as Error).message})`);
    return;
  }

  // Pull a title for the schema folder when not flat.
  const titleProp = exp.rows[0]?.title;
  const dbSlug = flat ? '' : slugify(titleProp || 'database');
  const baseFolder = flat ? pageFolder : path.posix.join(pageFolder, dbSlug);

  const indexPath = path.posix.join(baseFolder, '_index.json');
  const indexFull = path.join(opts.repoRoot, '.volt', indexPath);
  const indexContent = JSON.stringify(
    {
      databaseId: exp.databaseId,
      dataSourceId: exp.dataSourceId,
      schema: exp.schema,
      rowCount: exp.rows.length,
      embedded: true,
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
    const rowSlug = slugify(row.title || row.id);
    const fileRel = path.posix.join(baseFolder, rowSlug + '.md');
    const filePath = path.join(opts.repoRoot, '.volt', fileRel);
    const body = await pageBlocksToMarkdown(opts.client, row.id);
    const notionContent = renderRowMarkdown(opts.config, row, exp, body);
    const written = await writeWithMerge(filePath, notionContent, row.id, state, mergeMap, opts.log ?? (() => {}));
    writtenPaths.add(path.normalize(filePath));

    state.entries[row.id] = {
      notionId: row.id,
      localPath: fileRel,
      notionLastEditedTime: row.lastEditedTime,
      contentHash: hashContent(written),
      baseContent: written,
    };
    rowsWritten += 1;
  }
  log(`    embedded db → ${baseFolder}: ${rowsWritten} row(s)`);
}

// Note: embedded DBs intentionally don't honor groupByProperty —
// they're discovered automatically from page blocks and don't have a
// mapping config attached. If a project needs grouping for a specific
// embedded DB, the user can promote it to an explicit mapping in
// .volt-sync.yml.

async function pullDatabase(
  opts: PullOptions,
  mapping: ResolvedMapping,
  state: SyncState,
  writtenPaths: Set<string>,
  skipIds: Set<string>,
  mergeMap: Map<string, Conflict>,
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
    const rowSlug = slugify(row.title || row.id);
    // groupByProperty (e.g. "Type") sorts rows into subfolders by the
    // property's value — so a Waterfall Tasks row with Type=Extension
    // lands at projectmanagement/waterfall-tasks/extension/<slug>.md
    // instead of mixed flat with Migrations/Integrations/etc.
    const groupSlug = rowGroupSlug(row, mapping.groupByProperty);
    const fileRel = path.posix.join(
      mapping.local,
      ...(groupSlug ? [groupSlug] : []),
      rowSlug + '.md',
    );
    const filePath = path.join(opts.repoRoot, '.volt', fileRel);
    const body = await pageBlocksToMarkdown(opts.client, row.id);
    const notionContent = renderRowMarkdown(opts.config, row, exp, body);
    const written = await writeWithMerge(filePath, notionContent, row.id, state, mergeMap, log);
    writtenPaths.add(path.normalize(filePath));

    state.entries[row.id] = {
      notionId: row.id,
      localPath: fileRel,
      notionLastEditedTime: row.lastEditedTime,
      contentHash: hashContent(written),
      baseContent: written,
    };
    rowsWritten += 1;

    // Recursively pull any child pages of this row. Each becomes a nested
    // markdown file beside the row at projectmanagement/<db>/<row-slug>/...
    // (or under the group folder if groupByProperty is set).
    const childPagesWritten = await pullRowChildPages(
      opts,
      mapping,
      row,
      rowSlug,
      groupSlug,
      state,
      writtenPaths,
      skipIds,
      mergeMap,
    );
    if (childPagesWritten > 0) {
      log(`    + ${childPagesWritten} child page(s) under ${rowSlug}/`);
    }
  }
  log(`  database rows: ${rowsWritten}`);
  return { rowsWritten };
}

// Read the configured groupByProperty value from a row. Supports the
// common Notion property types (select, multi_select, status,
// rich_text). Returns the slugified folder segment, or undefined when
// the property is missing/empty — caller falls back to flat layout.
function rowGroupSlug(row: NormalizedRow, propName: string | undefined): string | undefined {
  if (!propName) return undefined;
  const p = (row.rawProperties as Record<string, unknown>)[propName] as
    | { type?: string;
        select?: { name?: string } | null;
        multi_select?: Array<{ name?: string }>;
        status?: { name?: string } | null;
        rich_text?: Array<{ plain_text?: string }>;
      }
    | undefined;
  if (!p) return undefined;
  let raw: string | undefined;
  if (p.type === 'select') raw = p.select?.name;
  else if (p.type === 'multi_select') raw = p.multi_select?.[0]?.name;
  else if (p.type === 'status') raw = p.status?.name;
  else if (p.type === 'rich_text') raw = p.rich_text?.[0]?.plain_text;
  if (!raw || !raw.trim()) return undefined;
  return slugify(raw);
}

async function pullRowChildPages(
  opts: PullOptions,
  mapping: ResolvedMapping,
  row: NormalizedRow,
  rowSlug: string,
  groupSlug: string | undefined,
  state: SyncState,
  writtenPaths: Set<string>,
  skipIds: Set<string>,
  mergeMap: Map<string, Conflict>,
): Promise<number> {
  const tree = await walkPageTree(opts.client, row.id, {
    shouldDescend: (node) => !isIgnoredNotion([...node.parentPath, node.title], opts.config.notionIgnore),
  });
  // First entry is the row itself; skip it.
  const descendants = tree.slice(1);

  let written = 0;
  for (const node of descendants) {
    if (isIgnoredNotion([...node.parentPath, node.title], opts.config.notionIgnore)) continue;
    if (skipIds.has(node.id)) continue;

    // node.parentPath[0] is the row title; everything between is intermediate
    // directories that the file should land under, plus the node's own slug.
    // preserveCase keeps acronyms like "FDD"/"TDD" intact in the filename and
    // lets users name a sub-page literally "test-report" to land it as-is.
    const intermediate = node.parentPath.slice(1).map((s) => slugify(s, { preserveCase: true }));
    const fileRel = path.posix.join(
      mapping.local,
      ...(groupSlug ? [groupSlug] : []),
      rowSlug,
      ...intermediate,
      slugify(node.title, { preserveCase: true }) + '.md',
    );
    const filePath = path.join(opts.repoRoot, '.volt', fileRel);

    const body = await pageBlocksToMarkdown(opts.client, node.id);
    const notionContent = renderChildPageMarkdown(opts.config, node, row.id, body);
    const log = opts.log ?? (() => {});
    const writtenContent = await writeWithMerge(filePath, notionContent, node.id, state, mergeMap, log);
    writtenPaths.add(path.normalize(filePath));

    state.entries[node.id] = {
      notionId: node.id,
      localPath: fileRel,
      notionLastEditedTime: node.lastEditedTime,
      contentHash: hashContent(writtenContent),
      baseContent: writtenContent,
    };
    written += 1;
  }
  return written;
}

function renderChildPageMarkdown(
  config: Config,
  node: NotionPageNode,
  rowId: string,
  body: string,
): string {
  const trimmed = body.trim();
  if (!config.markdown.frontmatter) return `# ${node.title}\n\n${trimmed}\n`;
  const fm = {
    notion_id: node.id,
    notion_url: node.url,
    last_edited_time: node.lastEditedTime,
    title: node.title,
    parent_row_id: rowId,
  };
  return `---\n${YAML.stringify(fm).trimEnd()}\n---\n\n# ${node.title}\n\n${trimmed}\n`;
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

function renderRowMarkdown(
  config: Config,
  row: NormalizedRow,
  exp: DatabaseExport,
  body: string,
): string {
  const trimmedBody = body.trim();
  if (!config.markdown.frontmatter) {
    return `# ${row.title}\n\n${trimmedBody}\n`;
  }
  const fm = {
    notion_id: row.id,
    notion_url: row.url,
    last_edited_time: row.lastEditedTime,
    title: row.title,
    data_source_id: exp.dataSourceId,
    properties: row.properties,
  };
  return `---\n${YAML.stringify(fm).trimEnd()}\n---\n\n# ${row.title}\n\n${trimmedBody}\n`;
}

export async function writeFileEnsured(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

async function pruneStale(
  repoRoot: string,
  mappings: ResolvedMapping[],
  writtenPaths: Set<string>,
  localIgnore: string[],
  log: (msg: string) => void,
): Promise<number> {
  const voltRoot = path.join(repoRoot, '.volt');
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
        // Honor localIgnore — files matching these patterns are
        // repo-only artifacts (test reports, etc.) that aren't sourced
        // from Notion and shouldn't be pruned even when they sit inside
        // a mapped folder. Pattern is matched against the .volt-relative
        // path with forward slashes (minimatch convention).
        const relFromVolt = path.relative(voltRoot, f).split(path.sep).join('/');
        if (matchesAny(relFromVolt, localIgnore)) continue;
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
