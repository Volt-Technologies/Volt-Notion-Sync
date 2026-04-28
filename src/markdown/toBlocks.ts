import { Lexer, type Tokens, type Token } from 'marked';

interface RichText {
  type: 'text';
  text: { content: string; link?: { url: string } | null };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
  };
}

export interface NotionBlock {
  object: 'block';
  type: string;
  [key: string]: unknown;
}

const NOTION_TEXT_LIMIT = 2000;

export function markdownToBlocks(body: string): NotionBlock[] {
  const lexer = new Lexer();
  const tokens = lexer.lex(body);
  const blocks: NotionBlock[] = [];
  for (const token of tokens) {
    blocks.push(...tokenToBlocks(token));
  }
  return blocks;
}

function tokenToBlocks(token: Token): NotionBlock[] {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      const level = Math.min(Math.max(t.depth, 1), 3);
      return [
        {
          object: 'block',
          type: `heading_${level}`,
          [`heading_${level}`]: { rich_text: inlineToRichText(t.text) },
        },
      ];
    }
    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      return [
        { object: 'block', type: 'paragraph', paragraph: { rich_text: inlineToRichText(t.text) } },
      ];
    }
    case 'space':
      return [];
    case 'hr':
      return [{ object: 'block', type: 'divider', divider: {} }];
    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      const text = t.tokens
        .filter((tk) => tk.type === 'paragraph' || tk.type === 'text')
        .map((tk) => (tk as { text?: string }).text ?? '')
        .join(' ');
      return [{ object: 'block', type: 'quote', quote: { rich_text: inlineToRichText(text) } }];
    }
    case 'code': {
      const t = token as Tokens.Code;
      return [
        {
          object: 'block',
          type: 'code',
          code: {
            rich_text: [{ type: 'text', text: { content: truncate(t.text) } }],
            language: mapCodeLanguage(t.lang),
          },
        },
      ];
    }
    case 'list': {
      const t = token as Tokens.List;
      const out: NotionBlock[] = [];
      for (const item of t.items) {
        out.push(listItemToBlock(item, t.ordered));
      }
      return out;
    }
    case 'table': {
      const t = token as Tokens.Table;
      const rows: NotionBlock[] = [];
      const headerRow: NotionBlock = {
        object: 'block',
        type: 'table_row',
        table_row: { cells: t.header.map((h) => inlineToRichText(h.text)) },
      };
      rows.push(headerRow);
      for (const row of t.rows) {
        rows.push({
          object: 'block',
          type: 'table_row',
          table_row: { cells: row.map((c) => inlineToRichText(c.text)) },
        });
      }
      return [
        {
          object: 'block',
          type: 'table',
          table: {
            table_width: t.header.length,
            has_column_header: true,
            has_row_header: false,
            children: rows,
          },
        },
      ];
    }
    case 'html':
      return [];
    default: {
      const text = (token as { text?: string; raw?: string }).text ?? (token as { raw?: string }).raw ?? '';
      if (!text.trim()) return [];
      return [
        { object: 'block', type: 'paragraph', paragraph: { rich_text: inlineToRichText(text) } },
      ];
    }
  }
}

function listItemToBlock(item: Tokens.ListItem, ordered: boolean): NotionBlock {
  const text = extractItemText(item);
  if (item.task) {
    return {
      object: 'block',
      type: 'to_do',
      to_do: { rich_text: inlineToRichText(text), checked: Boolean(item.checked) },
    };
  }
  const type = ordered ? 'numbered_list_item' : 'bulleted_list_item';
  return {
    object: 'block',
    type,
    [type]: { rich_text: inlineToRichText(text) },
  };
}

function extractItemText(item: Tokens.ListItem): string {
  const parts: string[] = [];
  for (const tk of item.tokens) {
    if (tk.type === 'text' || tk.type === 'paragraph') {
      parts.push((tk as { text?: string }).text ?? '');
    }
  }
  return parts.join(' ').trim();
}

function inlineToRichText(text: string): RichText[] {
  if (!text) return [];
  const out: RichText[] = [];
  const lexer = new Lexer();
  const tokens = lexer.inlineTokens(text);
  for (const tk of tokens) {
    out.push(...inlineTokenToRichText(tk, {}));
  }
  return mergeAdjacent(out);
}

interface Annotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}

function inlineTokenToRichText(token: Token, ann: Annotations, link?: string): RichText[] {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text;
      return [textRich(t.text, ann, link)];
    }
    case 'strong': {
      const t = token as Tokens.Strong;
      return childrenRich(t.tokens, { ...ann, bold: true }, link);
    }
    case 'em': {
      const t = token as Tokens.Em;
      return childrenRich(t.tokens, { ...ann, italic: true }, link);
    }
    case 'del': {
      const t = token as Tokens.Del;
      return childrenRich(t.tokens, { ...ann, strikethrough: true }, link);
    }
    case 'codespan': {
      const t = token as Tokens.Codespan;
      return [textRich(t.text, { ...ann, code: true }, link)];
    }
    case 'link': {
      const t = token as Tokens.Link;
      return childrenRich(t.tokens, ann, t.href);
    }
    case 'br':
      return [textRich('\n', ann, link)];
    case 'escape': {
      const t = token as Tokens.Escape;
      return [textRich(t.text, ann, link)];
    }
    default: {
      const text = (token as { text?: string; raw?: string }).text ?? (token as { raw?: string }).raw ?? '';
      return text ? [textRich(text, ann, link)] : [];
    }
  }
}

function childrenRich(tokens: Token[], ann: Annotations, link: string | undefined): RichText[] {
  const out: RichText[] = [];
  for (const tk of tokens) out.push(...inlineTokenToRichText(tk, ann, link));
  return out;
}

function textRich(content: string, ann: Annotations, link: string | undefined): RichText {
  const rt: RichText = {
    type: 'text',
    text: { content: truncate(content), link: link ? { url: link } : null },
  };
  if (ann.bold || ann.italic || ann.strikethrough || ann.code) rt.annotations = ann;
  return rt;
}

function mergeAdjacent(rich: RichText[]): RichText[] {
  const out: RichText[] = [];
  for (const cur of rich) {
    const prev = out[out.length - 1];
    if (
      prev &&
      sameAnnotations(prev.annotations, cur.annotations) &&
      sameLink(prev.text.link, cur.text.link)
    ) {
      prev.text.content = truncate(prev.text.content + cur.text.content);
    } else {
      out.push(cur);
    }
  }
  return out;
}

function sameAnnotations(a: Annotations | undefined, b: Annotations | undefined): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function sameLink(a: { url: string } | null | undefined, b: { url: string } | null | undefined): boolean {
  return (a?.url ?? null) === (b?.url ?? null);
}

function truncate(text: string): string {
  return text.length > NOTION_TEXT_LIMIT ? text.slice(0, NOTION_TEXT_LIMIT) : text;
}

function mapCodeLanguage(lang: string | undefined): string {
  const l = (lang ?? '').toLowerCase().trim();
  const supported = new Set([
    'abap', 'arduino', 'bash', 'basic', 'c', 'clojure', 'coffeescript', 'c++', 'c#',
    'css', 'dart', 'diff', 'docker', 'elixir', 'elm', 'erlang', 'flow', 'fortran', 'f#',
    'gherkin', 'glsl', 'go', 'graphql', 'groovy', 'haskell', 'html', 'java', 'javascript',
    'json', 'julia', 'kotlin', 'latex', 'less', 'lisp', 'livescript', 'lua', 'makefile',
    'markdown', 'markup', 'matlab', 'mermaid', 'nix', 'objective-c', 'ocaml', 'pascal',
    'perl', 'php', 'plain text', 'powershell', 'prolog', 'protobuf', 'python', 'r',
    'reason', 'ruby', 'rust', 'sass', 'scala', 'scheme', 'scss', 'shell', 'sql', 'swift',
    'typescript', 'vb.net', 'verilog', 'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml',
  ]);
  if (supported.has(l)) return l;
  if (l === 'js') return 'javascript';
  if (l === 'ts') return 'typescript';
  if (l === 'sh' || l === 'zsh') return 'bash';
  if (l === 'yml') return 'yaml';
  if (l === 'py') return 'python';
  return 'plain text';
}
