import { readFile } from 'node:fs/promises';
import matter from 'gray-matter';

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  notionId: string | null;
  notionUrl: string | null;
  lastEditedTime: string | null;
  title: string | null;
  properties: Record<string, unknown> | null;
  dataSourceId: string | null;
}

export async function parseMarkdownFile(filePath: string): Promise<ParsedMarkdown> {
  const raw = await readFile(filePath, 'utf-8');
  return parseMarkdown(raw);
}

export function parseMarkdown(raw: string): ParsedMarkdown {
  const { data, content } = matter(raw);
  const body = stripLeadingTitle(content);
  const fm = data as Record<string, unknown>;
  return {
    frontmatter: fm,
    body,
    notionId: typeof fm.notion_id === 'string' ? fm.notion_id : null,
    notionUrl: typeof fm.notion_url === 'string' ? fm.notion_url : null,
    lastEditedTime: typeof fm.last_edited_time === 'string' ? fm.last_edited_time : null,
    title: typeof fm.title === 'string' ? fm.title : null,
    properties:
      fm.properties && typeof fm.properties === 'object'
        ? (fm.properties as Record<string, unknown>)
        : null,
    dataSourceId: typeof fm.data_source_id === 'string' ? fm.data_source_id : null,
  };
}

function stripLeadingTitle(body: string): string {
  return body.replace(/^\s*#\s+.+\n+/, '');
}
