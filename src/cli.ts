#!/usr/bin/env node
import { Command } from 'commander';
import { writeFile, mkdir, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, ConfigError } from './config/load.js';
import { QUICKSTART_TEMPLATE_YAML, WORKFLOW_TEMPLATE_YAML } from './config/defaults.js';
import { createNotionClient } from './notion/client.js';
import { resolveMappings, inspectRoot } from './mapping/resolve.js';
import { pull } from './sync/pull.js';
import { push } from './sync/push.js';
import { bootstrap, renderMappingsYaml } from './bootstrap/run.js';
import type { Config, ResolvedMapping } from './config/types.js';

const program = new Command();
program
  .name('volt-notion-sync')
  .description('Sync a Notion teamspace to/from a project repo as markdown')
  .version('0.2.0');

program
  .command('pull')
  .description('Pull Notion → repo')
  .option('--repo <path>', 'project repo root', process.cwd())
  .option('--token <token>', 'Notion integration token (defaults to $NOTION_TOKEN)')
  .action(async (opts) => {
    const { config, client, mappings, repoRoot } = await prepare(opts);
    const result = await pull({ client, repoRoot, config, mappings, log: (m) => console.log(m) });
    console.log(JSON.stringify(redactConflicts(result), null, 2));
  });

program
  .command('push')
  .description('Push repo → Notion')
  .option('--repo <path>', 'project repo root', process.cwd())
  .option('--token <token>', 'Notion integration token (defaults to $NOTION_TOKEN)')
  .option('--mapping <name>', 'Only push files belonging to mapping <name>')
  .action(async (opts) => {
    const { config, client, mappings, repoRoot } = await prepare(opts);
    const filtered = opts.mapping ? filterMappingByName(mappings, opts.mapping) : mappings;
    const result = await push({
      client,
      repoRoot,
      config,
      mappings: filtered,
      log: (m) => console.log(m),
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('sync')
  .description('Pull then push, with conflict policy applied')
  .option('--repo <path>', 'project repo root', process.cwd())
  .option('--token <token>', 'Notion integration token (defaults to $NOTION_TOKEN)')
  .option('--strategy <strategy>', 'Only sync mappings with commitStrategy <direct|pr>')
  .action(async (opts) => {
    const { config, client, mappings, repoRoot } = await prepare(opts);
    const filtered = opts.strategy
      ? mappings.filter((m) => m.resolvedCommitStrategy === opts.strategy)
      : mappings;
    if (filtered.length === 0) {
      console.log('no mappings match filter');
      return;
    }
    const pulled = await pull({
      client,
      repoRoot,
      config,
      mappings: filtered,
      log: (m) => console.log(`[pull] ${m}`),
    });
    console.log('pull:', JSON.stringify(redactConflicts(pulled)));
    const pushed = await push({
      client,
      repoRoot,
      config,
      mappings: filtered,
      log: (m) => console.log(`[push] ${m}`),
    });
    console.log('push:', JSON.stringify(pushed));
  });

program
  .command('inspect')
  .description('List the children under rootPageId — useful for filling in mappings')
  .option('--repo <path>', 'project repo root', process.cwd())
  .option('--token <token>', 'Notion integration token (defaults to $NOTION_TOKEN)')
  .action(async (opts) => {
    const { config, client } = await prepare(opts);
    const result = await inspectRoot(client, config.notion.rootPageId);
    console.log(`root: ${result.rootTitle}`);
    for (const c of result.children) {
      console.log(`  [${c.kind}] ${c.title}  (${c.id})`);
    }
  });

program
  .command('routes')
  .description('Print mappings classified by commitStrategy as JSON (used by GH Actions)')
  .option('--repo <path>', 'project repo root', process.cwd())
  .option('--token <token>', 'Notion integration token (defaults to $NOTION_TOKEN)')
  .option('--no-resolve', 'Do not contact Notion; classify by static config only')
  .action(async (opts) => {
    const repoRoot = path.resolve(opts.repo);
    const config = await loadConfigOrDie(repoRoot);
    const direct: string[] = [];
    const pr: Array<{ name: string; paths: string[] }> = [];
    for (const m of config.mappings) {
      const strategy = m.commitStrategy ?? config.commitStrategy;
      const pathPattern = `.volt/${m.local}/**`;
      if (strategy === 'pr') {
        pr.push({ name: m.notion ?? m.notionId ?? m.local, paths: [pathPattern] });
      } else {
        direct.push(pathPattern);
      }
    }
    console.log(JSON.stringify({ direct, pr }, null, 2));
  });

program
  .command('bootstrap')
  .description(
    'Build the Volt project template under a starter page (Project Home + 14 databases + relations + 3 resource pages + 5 waterfall sub-pages)',
  )
  .argument('<starter-page-id>', 'Notion page id under which to create Project Home (must already be shared with the integration)')
  .option('--token <token>', 'Notion integration token (defaults to $NOTION_TOKEN)')
  .action(async (starterPageId: string, opts: { token?: string }) => {
    const token = opts.token || process.env.NOTION_TOKEN;
    if (!token) die('NOTION_TOKEN is required (env var or --token)');
    const client = createNotionClient({ token });
    const result = await bootstrap({
      client,
      starterPageId,
      log: (m) => console.log(m),
    });
    console.log('\n✓ Bootstrap complete.');
    console.log(`Project Home id: ${result.projectHomeId}`);
    console.log('\nPaste this into .volt/.volt-sync.yml:\n');
    console.log(renderMappingsYaml(result));
  });

program
  .command('scaffold')
  .description('Drop the workflow + config templates and CLI bundle into the current repo')
  .option('--repo <path>', 'project repo root', process.cwd())
  .option('--force', 'overwrite existing files', false)
  .option('--bundle <path>', 'path to volt-notion-sync.cjs to copy into .volt/.cli/')
  .action(async (opts) => {
    const repoRoot = path.resolve(opts.repo);
    const targets: Array<{ to: string; content: string }> = [
      { to: path.join(repoRoot, '.volt', '.volt-sync.yml'), content: QUICKSTART_TEMPLATE_YAML },
      {
        to: path.join(repoRoot, '.github', 'workflows', 'volt-notion-sync.yml'),
        content: WORKFLOW_TEMPLATE_YAML,
      },
    ];
    for (const t of targets) {
      if (!opts.force && (await exists(t.to))) {
        console.log(`skip (exists): ${path.relative(repoRoot, t.to)}`);
        continue;
      }
      await mkdir(path.dirname(t.to), { recursive: true });
      await writeFile(t.to, t.content, 'utf-8');
      console.log(`wrote: ${path.relative(repoRoot, t.to)}`);
    }
    if (opts.bundle) {
      const dest = path.join(repoRoot, '.volt', '.cli', 'volt-notion-sync.cjs');
      if (!opts.force && (await exists(dest))) {
        console.log(`skip (exists): ${path.relative(repoRoot, dest)} (use --force to update)`);
      } else {
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(opts.bundle, dest);
        console.log(`wrote: ${path.relative(repoRoot, dest)}`);
      }
    } else {
      console.log('note: pass --bundle <path> to copy the CLI bundle into .volt/.cli/');
    }
  });

async function prepare(opts: {
  repo: string;
  token?: string;
}): Promise<{
  repoRoot: string;
  config: Config;
  client: ReturnType<typeof createNotionClient>;
  mappings: ResolvedMapping[];
}> {
  const token = opts.token || process.env.NOTION_TOKEN;
  if (!token) die('NOTION_TOKEN is required (env var or --token)');
  const repoRoot = path.resolve(opts.repo);
  const config = await loadConfigOrDie(repoRoot);
  const client = createNotionClient({ token });
  const mappings = await resolveMappings(client, config);
  return { repoRoot, config, client, mappings };
}

function filterMappingByName(mappings: ResolvedMapping[], name: string): ResolvedMapping[] {
  const match = mappings.filter(
    (m) => m.notion === name || m.local === name || m.local === `.volt/${name}`,
  );
  if (match.length === 0) die(`no mapping matches "${name}"`);
  return match;
}

function redactConflicts<T extends { conflicts: Array<{ mapping: unknown }> }>(result: T): unknown {
  return {
    ...result,
    conflicts: result.conflicts.map(({ mapping, ...rest }) => rest),
  };
}

async function loadConfigOrDie(repoRoot: string) {
  try {
    return await loadConfig(repoRoot);
  } catch (err) {
    if (err instanceof ConfigError) die(err.message);
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
