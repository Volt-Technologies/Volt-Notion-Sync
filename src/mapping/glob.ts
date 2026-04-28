import { minimatch } from 'minimatch';

export function matchesAny(value: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (minimatch(value, pattern, { dot: true, nocase: false })) return true;
  }
  return false;
}

export function isIgnoredNotion(notionPath: string[], patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const last = notionPath[notionPath.length - 1] ?? '';
  const joined = notionPath.join('/');
  for (const pattern of patterns) {
    if (
      minimatch(last, pattern, { dot: true }) ||
      minimatch(joined, pattern, { dot: true }) ||
      minimatch(joined, `**/${pattern}`, { dot: true })
    ) {
      return true;
    }
  }
  return false;
}
