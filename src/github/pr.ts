export interface OpenPrOptions {
  branch: string;
  title: string;
  body: string;
}

export async function openPr(_opts: OpenPrOptions): Promise<void> {
  throw new Error('openPr is not implemented yet — used by PR-mode mappings (e.g. PM Tasks).');
}
