import type { Client } from '@notionhq/client';

interface RawDatabase {
  id: string;
  title?: Array<{ plain_text?: string }>;
  data_sources?: Array<{ id: string; name?: string }>;
}

interface RawDataSource {
  id: string;
  title?: Array<{ plain_text?: string }>;
  properties: Record<string, { id: string; name: string; type: string }>;
}

interface RawRow {
  id: string;
  url?: string;
  archived?: boolean;
  in_trash?: boolean;
  last_edited_time: string;
  properties: Record<string, RawPropValue>;
}

interface RawPropValue {
  id: string;
  type: string;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  status?: { name: string } | null;
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  date?: { start: string; end?: string | null } | null;
  checkbox?: boolean;
  number?: number | null;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  people?: Array<{ name?: string; person?: { email?: string } }>;
}

export interface DatabaseExport {
  databaseId: string;
  dataSourceId: string;
  schema: RawDataSource['properties'];
  rows: NormalizedRow[];
}

export interface NormalizedRow {
  id: string;
  url: string;
  lastEditedTime: string;
  title: string;
  properties: Record<string, unknown>;
  rawProperties: RawRow['properties'];
}

export async function exportDatabase(client: Client, databaseId: string): Promise<DatabaseExport> {
  // @notionhq/client@2.3.x's typed `databases.retrieve` predates the
  // 2025-09-03 API split and doesn't surface `data_sources` in its
  // response — calling through `client.request` returns the raw payload
  // which does include the array.
  const c = client as unknown as { request: (args: unknown) => Promise<unknown> };
  const db = (await c.request({
    path: `databases/${databaseId}`,
    method: 'get',
  })) as RawDatabase;
  const dataSourceId = db.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new Error(
      `Database ${databaseId} has no data sources (Notion API 2025-09-03+ required). ` +
        `Raw response keys: ${Object.keys(db as unknown as Record<string, unknown>).join(', ')}`,
    );
  }
  const ds = (await fetchDataSource(client, dataSourceId)) as RawDataSource;
  const rows = await queryAllRows(client, dataSourceId);
  return {
    databaseId,
    dataSourceId,
    schema: ds.properties,
    rows: rows.filter((r) => !r.archived && !r.in_trash).map(normalizeRow),
  };
}

async function fetchDataSource(client: Client, dataSourceId: string): Promise<RawDataSource> {
  const c = client as unknown as { request: (args: unknown) => Promise<unknown> };
  return (await c.request({ path: `data_sources/${dataSourceId}`, method: 'get' })) as RawDataSource;
}

async function queryAllRows(client: Client, dataSourceId: string): Promise<RawRow[]> {
  const out: RawRow[] = [];
  let cursor: string | undefined;
  const c = client as unknown as { request: (args: unknown) => Promise<{ results: RawRow[]; has_more: boolean; next_cursor: string | null }> };
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await c.request({
      path: `data_sources/${dataSourceId}/query`,
      method: 'post',
      body,
    });
    out.push(...res.results);
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

function normalizeRow(raw: RawRow): NormalizedRow {
  const props: Record<string, unknown> = {};
  let title = 'Untitled';
  for (const [key, value] of Object.entries(raw.properties)) {
    const v = normalizeValue(value);
    props[key] = v;
    if (value.type === 'title' && typeof v === 'string' && v) title = v;
  }
  return {
    id: raw.id,
    url: raw.url ?? '',
    lastEditedTime: raw.last_edited_time,
    title,
    properties: props,
    rawProperties: raw.properties,
  };
}

function normalizeValue(prop: RawPropValue): unknown {
  switch (prop.type) {
    case 'title':
      return (prop.title ?? []).map((t) => t.plain_text ?? '').join('');
    case 'rich_text':
      return (prop.rich_text ?? []).map((t) => t.plain_text ?? '').join('');
    case 'status':
      return prop.status?.name ?? null;
    case 'select':
      return prop.select?.name ?? null;
    case 'multi_select':
      return (prop.multi_select ?? []).map((s) => s.name);
    case 'date':
      return prop.date?.start ?? null;
    case 'checkbox':
      return prop.checkbox ?? false;
    case 'number':
      return prop.number ?? null;
    case 'url':
      return prop.url ?? null;
    case 'email':
      return prop.email ?? null;
    case 'phone_number':
      return prop.phone_number ?? null;
    case 'people':
      return (prop.people ?? []).map((p) => p.name ?? p.person?.email ?? '').filter(Boolean);
    default:
      return null;
  }
}
