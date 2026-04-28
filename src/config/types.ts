import { z } from 'zod';

export const Direction = z.enum(['pull', 'push', 'both']);
export type Direction = z.infer<typeof Direction>;

export const CommitStrategy = z.enum(['direct', 'pr']);
export type CommitStrategy = z.infer<typeof CommitStrategy>;

export const ConflictPolicy = z.enum(['abort', 'notion-wins', 'github-wins']);
export type ConflictPolicy = z.infer<typeof ConflictPolicy>;

export const MappingType = z.enum(['page', 'database']);
export type MappingType = z.infer<typeof MappingType>;

export const MappingSchema = z
  .object({
    notion: z.string().optional(),
    notionId: z.string().optional(),
    local: z.string().min(1),
    type: MappingType.default('page'),
    direction: Direction.optional(),
    commitStrategy: CommitStrategy.optional(),
    optional: z.boolean().default(false),
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

export const ConfigSchema = z.object({
  version: z.literal(1),
  notion: z.object({
    teamspaceId: z.string().min(1),
    rootPageId: z.string().min(1),
  }),
  defaultDirection: Direction.default('both'),
  commitStrategy: CommitStrategy.default('direct'),
  conflictPolicy: ConflictPolicy.default('abort'),
  mappings: z.array(MappingSchema).min(1),
  notionIgnore: z.array(z.string()).default([]),
  localIgnore: z.array(z.string()).default([]),
  markdown: MarkdownOptions,
});

export type Config = z.infer<typeof ConfigSchema>;

export interface ResolvedMapping extends Mapping {
  resolvedNotionId: string;
  resolvedDirection: Direction;
  resolvedCommitStrategy: CommitStrategy;
}
