import type { Client } from '@notionhq/client';
import { listChildBlocks } from './walker.js';

interface RichText {
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
  };
}

interface Block {
  id: string;
  type: string;
  has_children?: boolean;
  paragraph?: { rich_text: RichText[] };
  heading_1?: { rich_text: RichText[] };
  heading_2?: { rich_text: RichText[] };
  heading_3?: { rich_text: RichText[] };
  bulleted_list_item?: { rich_text: RichText[] };
  numbered_list_item?: { rich_text: RichText[] };
  to_do?: { rich_text: RichText[]; checked?: boolean };
  toggle?: { rich_text: RichText[] };
  quote?: { rich_text: RichText[] };
  callout?: { rich_text: RichText[]; icon?: { emoji?: string } };
  code?: { rich_text: RichText[]; language?: string };
  divider?: Record<string, never>;
  child_page?: { title?: string };
  child_database?: { title?: string };
  bookmark?: { url: string; caption?: RichText[] };
  link_preview?: { url: string };
  embed?: { url: string };
  image?: { external?: { url: string }; file?: { url: string }; caption?: RichText[] };
  video?: { external?: { url: string }; file?: { url: string }; caption?: RichText[] };
  file?: { external?: { url: string }; file?: { url: string }; caption?: RichText[]; name?: string };
  table?: { table_width: number; has_column_header: boolean; has_row_header: boolean };
  table_row?: { cells: RichText[][] };
  equation?: { expression: string };
}

function renderRichText(rich: RichText[] | undefined): string {
  if (!rich) return '';
  return rich
    .map((rt) => {
      let text = rt.plain_text ?? '';
      const a = rt.annotations ?? {};
      if (a.code) text = `\`${text}\``;
      if (a.bold) text = `**${text}**`;
      if (a.italic) text = `*${text}*`;
      if (a.strikethrough) text = `~~${text}~~`;
      if (rt.href) text = `[${text}](${rt.href})`;
      return text;
    })
    .join('');
}

interface RenderContext {
  client: Client;
  indent: string;
  numberedCounter: number[];
}

async function renderChildren(
  client: Client,
  parentId: string,
  ctx: RenderContext,
): Promise<string> {
  const children = (await listChildBlocks(client, parentId)) as unknown as Block[];
  return await renderBlocks(client, children, ctx);
}

async function renderBlock(client: Client, block: Block, ctx: RenderContext): Promise<string> {
  const indent = ctx.indent;

  switch (block.type) {
    case 'paragraph': {
      const text = renderRichText(block.paragraph?.rich_text);
      return text ? `${indent}${text}\n` : '\n';
    }
    case 'heading_1':
      return `${indent}# ${renderRichText(block.heading_1?.rich_text)}\n`;
    case 'heading_2':
      return `${indent}## ${renderRichText(block.heading_2?.rich_text)}\n`;
    case 'heading_3':
      return `${indent}### ${renderRichText(block.heading_3?.rich_text)}\n`;
    case 'bulleted_list_item': {
      let out = `${indent}- ${renderRichText(block.bulleted_list_item?.rich_text)}\n`;
      if (block.has_children) {
        out += await renderChildren(client, block.id, { ...ctx, indent: indent + '  ', numberedCounter: [] });
      }
      return out;
    }
    case 'numbered_list_item': {
      const n = ctx.numberedCounter[ctx.numberedCounter.length - 1] ?? 1;
      let out = `${indent}${n}. ${renderRichText(block.numbered_list_item?.rich_text)}\n`;
      if (block.has_children) {
        out += await renderChildren(client, block.id, { ...ctx, indent: indent + '   ', numberedCounter: [] });
      }
      return out;
    }
    case 'to_do': {
      const checked = block.to_do?.checked ? 'x' : ' ';
      let out = `${indent}- [${checked}] ${renderRichText(block.to_do?.rich_text)}\n`;
      if (block.has_children) {
        out += await renderChildren(client, block.id, { ...ctx, indent: indent + '  ', numberedCounter: [] });
      }
      return out;
    }
    case 'toggle': {
      let out = `${indent}<details><summary>${renderRichText(block.toggle?.rich_text)}</summary>\n\n`;
      if (block.has_children) {
        out += await renderChildren(client, block.id, { ...ctx, indent, numberedCounter: [] });
      }
      out += `\n${indent}</details>\n`;
      return out;
    }
    case 'quote': {
      const lines = renderRichText(block.quote?.rich_text).split('\n');
      return lines.map((l) => `${indent}> ${l}`).join('\n') + '\n';
    }
    case 'callout': {
      const emoji = block.callout?.icon?.emoji ?? '💡';
      let out = `${indent}> ${emoji} ${renderRichText(block.callout?.rich_text)}\n`;
      if (block.has_children) {
        const inner = await renderChildren(client, block.id, { ...ctx, indent: '', numberedCounter: [] });
        out += inner.split('\n').map((l) => (l ? `${indent}> ${l}` : `${indent}>`)).join('\n') + '\n';
      }
      return out;
    }
    case 'code': {
      const lang = block.code?.language ?? '';
      const text = renderRichText(block.code?.rich_text);
      return `${indent}\`\`\`${lang}\n${text}\n${indent}\`\`\`\n`;
    }
    case 'divider':
      return `${indent}---\n`;
    case 'bookmark':
    case 'link_preview':
    case 'embed': {
      const url = block.bookmark?.url || block.link_preview?.url || block.embed?.url;
      return url ? `${indent}<${url}>\n` : '';
    }
    case 'image': {
      const url = block.image?.external?.url || block.image?.file?.url || '';
      const caption = renderRichText(block.image?.caption) || 'image';
      return url ? `${indent}![${caption}](${url})\n` : '';
    }
    case 'video':
    case 'file': {
      const data = block.video || block.file;
      const url = data?.external?.url || data?.file?.url || '';
      const name = block.file?.name || renderRichText(data?.caption) || 'file';
      return url ? `${indent}[${name}](${url})\n` : '';
    }
    case 'table': {
      const rows = (await listChildBlocks(client, block.id)) as unknown as Block[];
      const lines: string[] = [];
      rows.forEach((row, idx) => {
        const cells = row.table_row?.cells ?? [];
        const rendered = cells.map((c) => renderRichText(c).replace(/\|/g, '\\|') || ' ');
        lines.push(`${indent}| ${rendered.join(' | ')} |`);
        if (idx === 0 && block.table?.has_column_header) {
          lines.push(`${indent}| ${rendered.map(() => '---').join(' | ')} |`);
        }
      });
      return lines.join('\n') + '\n';
    }
    case 'equation':
      return `${indent}$$${block.equation?.expression ?? ''}$$\n`;
    case 'child_page': {
      const title = block.child_page?.title ?? 'Untitled';
      return `${indent}- [${title}](./${slugify(title)}/index.md)\n`;
    }
    case 'child_database': {
      const title = block.child_database?.title ?? 'Untitled';
      return `${indent}- [Database: ${title}](./${slugify(title)}/_index.json)\n`;
    }
    default:
      return `${indent}<!-- unsupported block: ${block.type} -->\n`;
  }
}

async function renderBlocks(
  client: Client,
  blocks: Block[],
  ctx: RenderContext,
): Promise<string> {
  let out = '';
  let prevType = '';
  let numberedRun = 0;
  for (const block of blocks) {
    if (block.type === 'numbered_list_item') {
      numberedRun = prevType === 'numbered_list_item' ? numberedRun + 1 : 1;
    } else {
      numberedRun = 0;
    }
    out += await renderBlock(client, block, {
      ...ctx,
      numberedCounter: [...ctx.numberedCounter, numberedRun || 1],
    });
    prevType = block.type;
  }
  return out;
}

export async function pageBlocksToMarkdown(client: Client, pageId: string): Promise<string> {
  const blocks = (await listChildBlocks(client, pageId)) as unknown as Block[];
  return await renderBlocks(client, blocks, { client, indent: '', numberedCounter: [] });
}

export function slugify(name: string, opts: { preserveCase?: boolean } = {}): string {
  const stripped = name.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const cased = opts.preserveCase ? stripped : stripped.toLowerCase();
  const charset = opts.preserveCase ? /[^A-Za-z0-9]+/g : /[^a-z0-9]+/g;
  return (
    cased.replace(charset, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled'
  );
}
