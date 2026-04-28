import { Client } from '@notionhq/client';

export interface NotionClientOptions {
  token: string;
  notionVersion?: string;
}

export function createNotionClient(opts: NotionClientOptions): Client {
  return new Client({
    auth: opts.token,
    notionVersion: opts.notionVersion ?? '2025-09-03',
  });
}

export function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

export function pageIdEquals(a: string, b: string): boolean {
  return normalizeId(a) === normalizeId(b);
}
