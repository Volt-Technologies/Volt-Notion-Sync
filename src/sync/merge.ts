import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export interface MergeOutcome {
  content: string;
  // true when git produced a conflict-free merge; false when there were
  // overlapping edits and we fell back to the Notion version.
  clean: boolean;
}

// Run a 3-way merge of three full-file versions using `git merge-file`.
//
// Semantics: keep changes from both sides where they don't overlap; on
// overlap, take Notion's version (the "ours" in three-way terms is the
// repo, so we deliberately bias the resolution toward Notion by writing
// Notion's content out when git reports any conflict).
//
// Why git merge-file (and not a JS lib): git is already on every CI
// runner that checks out the repo, the algorithm is identical to what
// developers see locally, and there's nothing to keep up to date in
// package-lock.
export async function mergePreferNotion(
  notionContent: string,
  localContent: string,
  baseContent: string,
): Promise<MergeOutcome> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'volt-merge-'));
  try {
    const localPath = path.join(tmp, 'local');
    const basePath = path.join(tmp, 'base');
    const notionPath = path.join(tmp, 'notion');
    await writeFile(localPath, localContent, 'utf-8');
    await writeFile(basePath, baseContent, 'utf-8');
    await writeFile(notionPath, notionContent, 'utf-8');
    const code = await runGitMergeFile(localPath, basePath, notionPath);
    if (code === 0) {
      const merged = await readFile(localPath, 'utf-8');
      return { content: merged, clean: true };
    }
    return { content: notionContent, clean: false };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// `git merge-file local base notion` rewrites `local` in place with the
// merge result. Exit 0 = clean; positive = number of unresolved hunks;
// negative = error.
function runGitMergeFile(local: string, base: string, notion: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['merge-file', '--quiet', local, base, notion], {
      stdio: 'ignore',
    });
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => resolve(code ?? -1));
  });
}
