import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { matchesAny } from '../mapping/glob.js';
import type { ResolvedMapping } from '../config/types.js';

export interface LocalFile {
  absPath: string;
  relPath: string;
  mapping: ResolvedMapping;
}

export async function listLocalFiles(
  repoRoot: string,
  mappings: ResolvedMapping[],
  ignorePatterns: string[],
): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  for (const mapping of mappings) {
    const root = path.join(repoRoot, '.volt', mapping.local);
    const files = await listFilesRecursiveSafe(root);
    for (const abs of files) {
      const rel = path.relative(path.join(repoRoot, '.volt'), abs).split(path.sep).join('/');
      if (!abs.endsWith('.md')) continue;
      if (matchesAny(rel, ignorePatterns)) continue;
      out.push({ absPath: abs, relPath: rel, mapping });
    }
  }
  return out;
}

async function listFilesRecursiveSafe(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    const out: string[] = [];
    for (const name of entries) {
      const full = path.join(dir, name);
      const s = await stat(full);
      if (s.isDirectory()) out.push(...(await listFilesRecursiveSafe(full)));
      else out.push(full);
    }
    return out;
  } catch {
    return [];
  }
}
