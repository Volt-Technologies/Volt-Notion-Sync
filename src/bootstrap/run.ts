/**
 * src/bootstrap/run.ts
 *
 * Builds the Volt project Notion template under any starter page where
 * the integration has access. Returns the IDs of every created entity so
 * the caller can emit a `.volt-sync.yml` mappings block.
 */

import type { Client } from '@notionhq/client';
import {
  DATABASES,
  RELATIONS,
  WATERFALL_SUBPAGES,
  columnList,
  column,
  divider,
  heading1,
  heading2,
  linkDb,
  linkPage,
  paragraph,
  type DbSpec,
} from './template.js';

export interface BootstrapResult {
  projectHomeId: string;
  settingsId: string;
  qsdId: string;
  resourcePages: {
    processFlows: string;
    projectDefinition: string;
    waterfallTasks: string;
  };
  databases: Record<string, string>;
  waterfallSubpages: Record<string, string>;
}

export interface BootstrapOptions {
  client: Client;
  starterPageId: string;
  log?: (msg: string) => void;
}

export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const log = opts.log ?? (() => {});
  const c = opts.client;

  // — 1. page hierarchy ————————————————————————————————————————————
  log('=== step 1: page tree ===');
  const home     = await mkPage(c, opts.starterPageId, 'Project Home',           '🌅', log);
  const settings = await mkPage(c, home.id,            'Settings',               '🛠️', log);
  const qsd      = await mkPage(c, settings.id,        'Quick Start Databases',  '🗄️', log);

  // — 2. resource pages ———————————————————————————————————————————
  log('\n=== step 2: resource pages ===');
  const pf  = await mkPage(c, home.id, 'Process Flows',      '🔀', log);
  const pd  = await mkPage(c, home.id, 'Project Definition', '📘', log);
  const wt  = await mkPage(c, home.id, 'Waterfall Tasks',    '✅', log);

  // — 3. databases (no relations yet) ——————————————————————————————
  log(`\n=== step 3: ${DATABASES.length} databases ===`);
  const dbIds: Record<string, string> = {};
  for (const spec of DATABASES) {
    const parentId = spec.parent === 'qsd' ? qsd.id : settings.id;
    const id = await mkDb(c, parentId, spec, log);
    dbIds[spec.name] = id;
  }

  const need = (name: string): string => {
    const id = dbIds[name];
    if (!id) throw new Error(`bootstrap: missing DB "${name}"`);
    return id;
  };

  // — 4. relations ——————————————————————————————————————————————————
  log('\n=== step 4: relations ===');
  for (const [from, prop, to] of RELATIONS) {
    await addRelation(c, need(from), prop, need(to), log);
  }

  // — 5. rollup on Notes ————————————————————————————————————————————
  log('\n=== step 5: rollup ===');
  await c.databases.update({
    database_id: need('Notes'),
    properties: {
      'Abstract Process Flow': {
        rollup: {
          relation_property_name: 'Process Flows',
          rollup_property_name: 'Abstract Process Flow',
          function: 'show_unique',
        },
      },
    } as never,
  });
  log('  rollup Abstract Process Flow');

  // — 6. Project Home structural content ————————————————————————————
  log('\n=== step 6: project home content ===');
  await c.blocks.children.append({
    block_id: home.id,
    children: [
      divider(),
      columnList([
        column([
          heading2('Process Flows'),
          linkPage(pf.id),
        ]),
        column([
          heading2('Waterfall Tasks'),
          linkPage(wt.id),
          heading2('Project Definition'),
          linkPage(pd.id),
        ]),
        column([
          heading2('Resources'),
          linkPage(pf.id),
          linkPage(wt.id),
          linkPage(pd.id),
          linkPage(settings.id),
        ]),
      ]),
      heading1('Meetings'),
      divider(),
      paragraph('Mirrored under Settings → Meetings.'),
      linkDb(need('Meetings')),
      divider(),
      heading2('Miscellaneous'),
      linkDb(need('Project Notes')),
      linkDb(need('Transcripts')),
    ] as never,
  });
  log('  added column layout + Meetings header + Miscellaneous section');

  // — 7. Waterfall Tasks sub-pages ——————————————————————————————————
  log('\n=== step 7: waterfall tasks sub-pages ===');
  const subIds: Record<string, string> = {};
  for (const sp of WATERFALL_SUBPAGES) {
    const targetId = sp.linkTarget === 'self' ? need('Waterfall Tasks') : need('Issues');
    const description = sp.filter
      ? `Filtered view of Waterfall Tasks where Type = "${sp.filter}".`
      : 'Issues are tracked in their own database.';
    const next = sp.filter
      ? `To finish: in the Notion UI, type /linked, embed the Waterfall Tasks database, and add a filter Type = "${sp.filter}".`
      : 'Open the Issues database below.';
    const r = await c.pages.create({
      parent: { type: 'page_id', page_id: wt.id },
      icon: { type: 'emoji', emoji: sp.icon as never },
      properties: { title: { title: [{ text: { content: sp.name } }] } } as never,
      children: [
        paragraph(description),
        paragraph(next, true),
        linkDb(targetId),
      ] as never,
    });
    subIds[sp.name] = r.id;
    log(`  ✓ ${sp.name.padEnd(13)} ${r.id}`);
  }

  return {
    projectHomeId: home.id,
    settingsId: settings.id,
    qsdId: qsd.id,
    resourcePages: {
      processFlows: pf.id,
      projectDefinition: pd.id,
      waterfallTasks: wt.id,
    },
    databases: dbIds,
    waterfallSubpages: subIds,
  };
}

// ---------------------------------------------------------------------------

async function mkPage(
  c: Client,
  parentId: string,
  title: string,
  emoji: string,
  log: (msg: string) => void,
): Promise<{ id: string }> {
  const r = await c.pages.create({
    parent: { type: 'page_id', page_id: parentId },
    icon: { type: 'emoji', emoji: emoji as never },
    properties: { title: { title: [{ text: { content: title } }] } } as never,
  });
  log(`  page   ${r.id} · ${title}`);
  return { id: r.id };
}

async function mkDb(
  c: Client,
  parentId: string,
  spec: DbSpec,
  log: (msg: string) => void,
): Promise<string> {
  const r = await c.databases.create({
    parent: { type: 'page_id', page_id: parentId },
    title: [{ text: { content: spec.name } }],
    properties: {
      [spec.titleProp]: { title: {} },
      ...spec.properties,
    } as never,
  });
  log(`  db     ${r.id} · ${spec.name}`);
  return r.id;
}

async function addRelation(
  c: Client,
  fromDb: string,
  name: string,
  toDb: string,
  log: (msg: string) => void,
): Promise<void> {
  await c.databases.update({
    database_id: fromDb,
    properties: {
      [name]: {
        relation: {
          database_id: toDb,
          type: 'single_property',
          single_property: {},
        },
      },
    } as never,
  });
  log(`  rel    ${name} → ${toDb.slice(-12)}`);
}

// ---------------------------------------------------------------------------
// .volt-sync.yml mappings block — paste-ready output for the new project.
// ---------------------------------------------------------------------------

export function renderMappingsYaml(r: BootstrapResult): string {
  const lines: string[] = [];
  lines.push(`notion:`);
  lines.push(`  teamspaceId: ${r.projectHomeId}`);
  lines.push(`  rootPageId:  ${r.projectHomeId}`);
  lines.push('');
  lines.push(`mappings:`);
  lines.push(`  # ── docs/ — page trees ──────────────────────────────────────────────`);
  lines.push(`  - notion: "Process Flows"`);
  lines.push(`    notionId: ${r.resourcePages.processFlows}`);
  lines.push(`    local: docs/process-flows`);
  lines.push(`  - notion: "Project Definition"`);
  lines.push(`    notionId: ${r.resourcePages.projectDefinition}`);
  lines.push(`    local: docs/project-definition`);
  lines.push(`  - notion: "Waterfall Tasks"`);
  lines.push(`    notionId: ${r.resourcePages.waterfallTasks}`);
  lines.push(`    local: docs/waterfall-tasks`);
  lines.push('');
  lines.push(`  # ── projectmanagement/ — databases ──────────────────────────────────`);
  for (const spec of DATABASES) {
    const id = r.databases[spec.name];
    if (!id) continue;
    const slug = spec.name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    lines.push(`  - notion: "${spec.name}"`);
    lines.push(`    notionId: ${id}`);
    lines.push(`    local: projectmanagement/${slug}`);
    lines.push(`    type: database`);
  }
  return lines.join('\n');
}
