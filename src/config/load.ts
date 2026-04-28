import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { ConfigSchema, type Config } from './types.js';

export const CONFIG_FILENAME = '.volt-sync.yml';
export const VOLT_DIR = '.volt';

export class ConfigError extends Error {
  constructor(message: string, public readonly path?: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export async function loadConfig(repoRoot: string): Promise<Config> {
  const configPath = path.join(repoRoot, VOLT_DIR, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    throw new ConfigError(
      `Could not read ${VOLT_DIR}/${CONFIG_FILENAME} at ${configPath}. ` +
        `Run \`volt-notion-sync scaffold\` to create one.`,
      configPath,
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid YAML in ${configPath}: ${(err as Error).message}`, configPath);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid config in ${configPath}:\n${issues}`, configPath);
  }
  return result.data;
}
