import { z } from 'zod';

export const Direction = z.enum(['pull', 'push', 'both']);
export type Direction = z.infer<typeof Direction>;

export const CommitStrategy = z.enum(['direct', 'pr']);
export type CommitStrategy = z.infer<typeof CommitStrategy>;

export const ConflictPolicy = z.enum([
  'abort',
  'notion-wins',
  'github-wins',
  // Three-way merge per file using `git merge-file`: if local edits and
  // Notion edits don't overlap, both are kept; if they do overlap, the
  // Notion version wins. Frontmatter is regenerated from Notion on every
  // pull, so this only affects the markdown body in practice.
  'merge-prefer-notion',
]);
export type ConflictPolicy = z.infer<typeof ConflictPolicy>;

export const MappingType = z.enum(['page', 'database']);
export type MappingType = z.infer<typeof MappingType>;

export const MappingSchema = z
  .object({
    notion: z.string().optional(),
    notionId: z.string().optional(),
    // `local` is optional in repo overrides — a repo entry with only
    // `notion: "Process Flows"` and `disabled: true` (or just a property
    // override) inherits `local` from the matching standard mapping.
    local: z.string().min(1).optional(),
    // Left optional with no default — repo overrides that omit `type`
    // inherit from the matching standard mapping. Pure-repo extras get
    // 'page' filled in by mergeMappings.
    type: MappingType.optional(),
    direction: Direction.optional(),
    commitStrategy: CommitStrategy.optional(),
    optional: z.boolean().default(false),
    // Skip this standard mapping entirely. Repos use this to opt out of
    // a single mapping while still inheriting the rest. Has no effect on
    // mappings the repo defines from scratch.
    disabled: z.boolean().default(false),
    // Database mappings only: name of a Notion property whose value
    // becomes the per-row subfolder. Rows with property = "Extension"
    // land at <local>/extension/<row-slug>.md, etc. Supports select,
    // multi_select (first option), status, and rich_text properties.
    // Unset or property missing → flat layout under <local>/.
    groupByProperty: z.string().optional(),
  })
  .refine((m) => Boolean(m.notion || m.notionId), {
    message: 'each mapping must specify either `notion` (name) or `notionId` (uuid)',
  });

export type Mapping = z.infer<typeof MappingSchema>;

export const MarkdownOptions = z
  .object({
    frontmatter: z.boolean().default(true),
    attachments: z.string().default('.attachments'),
  })
  .default({ frontmatter: true, attachments: '.attachments' });

export type MarkdownOptions = z.infer<typeof MarkdownOptions>;

// Schema as it appears in `.volt/.volt-sync.yml` — what users write.
// `mappings` is optional because the standard mappings (baked into the
// CLI) cover most of what a repo needs; a repo can be entirely empty of
// custom mappings and still pull successfully.
export const ConfigSchema = z.object({
  version: z.literal(1),
  notion: z.object({
    teamspaceId: z.string().min(1),
    rootPageId: z.string().min(1),
  }),
  defaultDirection: Direction.default('both'),
  commitStrategy: CommitStrategy.default('direct'),
  // Default: on conflict (Notion AND local both changed since last
  // sync) Notion wins. The push path also consults this — under
  // notion-wins, files whose Notion page has been edited since our
  // recorded last_edited_time are skipped rather than overwritten. This
  // keeps the invariant "Notion is the source of truth for updates".
  conflictPolicy: ConflictPolicy.default('notion-wins'),
  mappings: z.array(MappingSchema).default([]),
  // Pull in the CLI's STANDARD_MAPPINGS (Process Flows, Waterfall Tasks,
  // Project Definition, Meetings — all marked optional). Repos override
  // by `notion:` name in their `mappings` list, or skip individually via
  // `disabled: true`. Set this to false if a repo wants full control.
  useStandardMappings: z.boolean().default(true),
  notionIgnore: z.array(z.string()).default([]),
  localIgnore: z.array(z.string()).default([]),
  markdown: MarkdownOptions,
});

export type Config = z.infer<typeof ConfigSchema>;

// After merge + resolution, `local` is always populated (standard
// mappings carry their own; overrides inherit from standard; pure repo
// entries are validated at load time). Narrow the type so downstream
// code doesn't have to keep guarding for undefined.
export interface ResolvedMapping extends Omit<Mapping, 'local'> {
  local: string;
  resolvedNotionId: string;
  resolvedDirection: Direction;
  resolvedCommitStrategy: CommitStrategy;
}
