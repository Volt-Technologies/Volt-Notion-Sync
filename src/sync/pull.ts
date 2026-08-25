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
import type { ConflictPolicy } from '../config/types.js';


export interface PullOptions {
  client: Client;
  repoRoot: string;
  config: Config;
  mappings: ResolvedMapping[];
  log?: (msg: string) => void;
  /**
   * Per-invocation override of `config.conflictPolicy`. Used by the
   * `pull-branches` flow so a single CLI run can sync `main` with the
   * project's normal policy AND a feature branch with `github-wins`
   * (preserve agent edits) without rewriting the config file.
   */
  conflictPolicyOverride?: ConflictPolicy;
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
  const effectivePolicy: ConflictPolicy = opts.conflictPolicyOverride ?? opts.config.conflictPolicy;
  const conflicts = await detectConflicts({
    client: opts.client,
    repoRoot: opts.repoRoot,
    state,
    mappings: opts.mappings,
  });
  const { aborted } = applyConflictPolicy(effectivePolicy, conflicts);
  if (aborted.length > 0) {
    // Throwing already prints formatConflicts to stderr; don't double-log.
    throw new Error(
      `Aborting pull due to ${aborted.length} conflict(s):\n${formatConflicts(aborted)}`,
    );
  }
  result.conflicts = conflicts;

  const skipIds = new Set(
    effectivePolicy === 'github-wins' ? conflicts.map((c) => c.notionId) : [],
  );
  // Index of both-changed conflicts the merge-prefer-notion path must
  // resolve in-line. Other policies leave this empty so writeWithMerge
  // is a straight passthrough.
  const mergeMap = new Map<string, Conflict>(
    effectivePolicy === 'merge-prefer-notion'
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

    const { markdown: md } = await pageBlocksToMarkdown(opts.client, node.id);
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

  // Same title-collision guard as pullDatabase. Embedded DBs carry no
  // mapping config, so there is no groupByProperty to partition by.
  const rowSlugs = assignRowSlugs(exp.rows, undefined, opts.config.notionIgnore);

  let rowsWritten = 0;
  for (const row of exp.rows) {
    if (isIgnoredNotion([row.title], opts.config.notionIgnore)) continue;
    if (skipIds.has(row.id)) continue;
    const rowSlug = rowSlugs.get(row.id) ?? slugify(row.title || row.id);
    const fileRel = path.posix.join(baseFolder, rowSlug + '.md');
    const filePath = path.join(opts.repoRoot, '.volt', fileRel);
    const { markdown: body } = await pageBlocksToMarkdown(opts.client, row.id);
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

  // Resolve every row's filename up front — uniqueness is a property of
  // the row set, not of any one row, so it can't be decided inside the
  // loop. See assignRowSlugs for the disambiguation rules.
  const rowSlugs = assignRowSlugs(exp.rows, mapping.groupByProperty, opts.config.notionIgnore);

  let rowsWritten = 0;
  let rowsSkipped = 0;
  for (const row of exp.rows) {
    if (isIgnoredNotion([row.title], opts.config.notionIgnore)) continue;
    if (skipIds.has(row.id)) continue;
    const rowSlug = rowSlugs.get(row.id) ?? slugify(row.title || row.id);
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

    // Incremental skip: when Notion's last_edited_time matches what we
    // last wrote to disk and the row isn't in conflict, the body and
    // child-page block list are guaranteed identical — Notion bumps the
    // row's timestamp on any structural change inside it. Reuse the
    // local file and skip pageBlocksToMarkdown + child-page walk
    // entirely. This is the difference between a 1000-call full pull
    // and a ~5-call no-op pull on subsequent CI runs.
    const inConflict = mergeMap.has(row.id);
    const localLastEdited = await readLocalLastEditedTime(filePath);
    if (!inConflict && localLastEdited === row.lastEditedTime) {
      const localContent = await readFile(filePath, 'utf-8');
      writtenPaths.add(path.normalize(filePath));
      // Child pages live under <rowSlug>/ — preserve them so prune
      // doesn't wipe an unchanged subtree.
      const childDir = path.join(
        opts.repoRoot,
        '.volt',
        mapping.local,
        ...(groupSlug ? [groupSlug] : []),
        rowSlug,
      );
      if (await directoryExists(childDir)) {
        await markSubtreeWritten(childDir, writtenPaths);
      }
      state.entries[row.id] = {
        notionId: row.id,
        localPath: fileRel,
        notionLastEditedTime: row.lastEditedTime,
        contentHash: hashContent(localContent),
        baseContent: localContent,
      };
      rowsSkipped += 1;
      continue;
    }

    const { markdown: body, childPageIds } = await pageBlocksToMarkdown(opts.client, row.id);
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
    // (or under the group folder if groupByProperty is set). Skip the
    // walk entirely when the row has no child_page blocks — saves 2 API
    // calls per leaf row (most rows), which dominates large-DB pull cost.
    if (childPageIds.length > 0) {
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
  }
  log(
    `  database rows: ${rowsWritten}` +
      (rowsSkipped > 0 ? ` (${rowsSkipped} unchanged, reused from local)` : ''),
  );
  return { rowsWritten };
}

// Assign every row the filename slug it will be written under, keeping
// them unique within their destination folder.
//
// `slugify(row.title)` alone is not injective: recurring meetings give a
// database many rows sharing one title. Clarion's Transcripts DB has 124
// rows and only 97 distinct titles — "(Internal) Clarion PMO" appears 10
// times, "Joe/Kelly Clarion Recurring Call" 9 times. Writing all of them
// to <slug>.md meant each occurrence silently overwrote the previous one
// and 27 transcripts never reached the repo, while the run still
// reported "124 rows written".
//
// Rules, chosen so this is a no-op for every row that isn't in a
// collision (a repo whose titles are already unique sees no renames):
//   - slug used by exactly one row in the folder → bare <slug>, unchanged
//   - collision, and every colliding row has a distinct date property →
//     <slug>-YYYY-MM-DD, which is what a human wants for meeting series
//   - collision otherwise → <slug>[-YYYY-MM-DD]-<id>, with the id prefix
//     grown until the name is free
//
// Uniqueness is established by claiming names against a per-folder
// `used` set rather than assumed from the discriminator, because no
// fixed-length id prefix is safe: Notion mints UUIDs in batches sharing
// a long common prefix. The candidate list ends at the full 32-hex id,
// so a free name always exists.
//
// Discriminators derive from stable row data, never from query order or
// lastEditedTime, and both the buckets and the rows inside them are
// sorted before assignment, so a row keeps its filename across pulls.
// Grouping is per destination folder, so groupByProperty subfolders are
// considered independently.
function assignRowSlugs(
  rows: NormalizedRow[],
  groupByProperty: string | undefined,
  notionIgnore: string[],
): Map<string, string> {
  const byTarget = new Map<string, NormalizedRow[]>();
  for (const row of rows) {
    if (isIgnoredNotion([row.title], notionIgnore)) continue;
    const base = slugify(row.title || row.id);
    const key = `${rowGroupSlug(row, groupByProperty) ?? ''}|${base}`;
    const bucket = byTarget.get(key);
    if (bucket) bucket.push(row);
    else byTarget.set(key, [row]);
  }

  const out = new Map<string, string>();
  // One `used` set per destination folder. Uniqueness has to hold across
  // the whole folder, not just within a title bucket, because a
  // date-suffixed name from one bucket could in principle equal another
  // bucket's bare name.
  const usedByGroup = new Map<string, Set<string>>();

  // Deterministic iteration: sort the bucket keys, and sort rows within
  // each bucket by id. Assignment therefore does not depend on the order
  // Notion happened to return rows in, so filenames are stable run over
  // run.
  for (const key of [...byTarget.keys()].sort()) {
    const bucket = byTarget.get(key)!.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const group = key.slice(0, key.indexOf('|'));
    const base = key.slice(key.indexOf('|') + 1);
    let used = usedByGroup.get(group);
    if (!used) usedByGroup.set(group, (used = new Set<string>()));

    // Decide the discriminator style once per bucket so every file in a
    // colliding group is named the same way. Dates only qualify when
    // every row has one and they are all distinct — otherwise a meeting
    // series recorded twice on one day would give one row the date and
    // the next an id, which reads like a mistake.
    const dates = bucket.map(rowDateStamp);
    const datesUnique =
      dates.every((d): d is string => Boolean(d)) && new Set(dates).size === dates.length;

    for (const row of bucket) {
      for (const candidate of nameCandidates(base, row, bucket.length === 1, datesUnique)) {
        if (used.has(candidate)) continue;
        used.add(candidate);
        out.set(row.id, candidate);
        break;
      }
    }
  }
  return out;
}

// Candidate filenames for a row, best first. The caller takes the first
// one not already claimed in the destination folder.
//
// The id-based fallbacks escalate in length rather than stopping at a
// short prefix. Notion mints UUIDs in batches that share a long common
// prefix — two rows in Kanner's Transcripts DB titled "Master Data 1:
// Product and Variant model" both start `39e3acdc` and share a date, so
// an 8-char discriminator still collided and one row lost its file. The
// last candidate is the full 32-hex id, unique by construction, so this
// generator can never be exhausted without producing a free name.
function* nameCandidates(
  base: string,
  row: NormalizedRow,
  alone: boolean,
  datesUnique: boolean,
): Generator<string> {
  // Only an uncontested title keeps the bare slug, so repos whose titles
  // are already unique see no renames.
  if (alone) yield base;
  const date = rowDateStamp(row);
  if (date && datesUnique) yield `${base}-${date}`;
  const hex = row.id.replace(/-/g, '');
  for (const len of [8, 12, 16, 24, 32]) {
    yield date ? `${base}-${date}-${hex.slice(0, len)}` : `${base}-${hex.slice(0, len)}`;
  }
}

// A date-typed property on the row, as YYYY-MM-DD. Notion dates arrive
// as either a bare date or a full ISO timestamp; both truncate cleanly
// at the first 10 characters. Returns undefined when the row has no
// date property or it is empty.
//
// Property names are sorted before picking so a database carrying more
// than one date column (Waterfall Tasks has both "Due Date" and "Start
// Date") always yields the same one. Relying on object key order would
// tie the filename to whatever order the API happened to serialise, and
// a reorder would silently rename files on the next pull.
function rowDateStamp(row: NormalizedRow): string | undefined {
  for (const name of Object.keys(row.rawProperties).sort()) {
    const p = row.rawProperties[name] as unknown as {
      type?: string;
      date?: { start?: string } | null;
    };
    if (p?.type !== 'date') continue;
    const start = p.date?.start;
    if (start && start.length >= 10) return start.slice(0, 10);
  }
  return undefined;
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

    const { markdown: body } = await pageBlocksToMarkdown(opts.client, node.id);
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

// Incremental sync helper: pull the previous pull's `last_edited_time`
// off the local file's YAML frontmatter so we can detect "Notion hasn't
// changed this row/page since we last wrote it." Returns null when the
// file is missing or has no frontmatter — both indistinguishable from
// "needs a full fetch."
async function readLocalLastEditedTime(filePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  try {
    const fm = YAML.parse(m[1]!) as { last_edited_time?: unknown };
    return typeof fm.last_edited_time === 'string' ? fm.last_edited_time : null;
  } catch {
    return null;
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// Mark every existing .md under `dir` as written so the prune pass
// leaves them alone. Used when an incremental skip reuses a whole
// subtree without re-fetching it from Notion.
async function markSubtreeWritten(dir: string, writtenPaths: Set<string>): Promise<void> {
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      const full = path.join(dir, name);
      const s = await stat(full);
      if (s.isDirectory()) {
        await markSubtreeWritten(full, writtenPaths);
      } else {
        writtenPaths.add(path.normalize(full));
      }
    }
  } catch {
    // Missing directory — nothing to mark.
  }
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
        // Local-born guard: a file with no notion_id in its frontmatter
        // never came from Notion — it's a new row/page created repo-side
        // (e.g. an extension created directly in the Volt platform)
        // waiting for the push leg to create it in Notion and write the
        // id back. Prune must not eat it. Only files that provably
        // mirrored a Notion page (they carry notion_id) are stale when
        // their source row disappears.
        if (!(await hasNotionId(f))) {
          log(`  kept (local-born, no notion_id): ${path.relative(repoRoot, f)}`);
          continue;
        }
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

// Does the file's YAML frontmatter carry a notion_id? Errors (missing
// file, no frontmatter, malformed YAML) all report false — the prune
// caller treats false as "keep", so unparseable files are never deleted.
async function hasNotionId(filePath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return false;
  }
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return false;
  try {
    const fm = YAML.parse(m[1]!) as { notion_id?: unknown };
    return typeof fm.notion_id === 'string' && fm.notion_id.length > 0;
  } catch {
    return false;
  }
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
