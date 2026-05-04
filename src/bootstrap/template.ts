/**
 * src/bootstrap/template.ts
 *
 * Declarative description of the Volt project Notion template:
 *   - 14 databases (schemas, options, single-property relations)
 *   - the rollup on Notes
 *   - the Project Home structural content (3-column layout, Meetings
 *     header, Miscellaneous section)
 *   - 5 sub-pages under the Waterfall Tasks resource page
 *
 * Pure data + small block-builder helpers. Orchestration lives in `run.ts`.
 */

// ---------------------------------------------------------------------------
// Property type factories — mirror the @notionhq/client property schemas.
// Typed loosely (`unknown`) to avoid wrestling SDK property unions; the
// shapes match what `databases.create` accepts.
// ---------------------------------------------------------------------------

type PropSchema = Record<string, unknown>;

export const TITLE = (): PropSchema => ({ title: {} });
export const RT = (): PropSchema => ({ rich_text: {} });
export const SEL = (...names: string[]): PropSchema => ({
  select: { options: names.map((name) => ({ name })) },
});
export const MS = (...names: string[]): PropSchema => ({
  multi_select: { options: names.map((name) => ({ name })) },
});
export const N = (): PropSchema => ({ number: { format: 'number' } });
export const D = (): PropSchema => ({ date: {} });
export const CB = (): PropSchema => ({ checkbox: {} });
export const URL_ = (): PropSchema => ({ url: {} });
export const PEOPLE = (): PropSchema => ({ people: {} });

// ---------------------------------------------------------------------------
// Database catalog. Each entry is created in order — placement (`parent`)
// is one of: 'qsd' (Quick Start Databases) or 'settings'.
// `relations` are added in a second pass so we don't need topological
// ordering of forward references.
// ---------------------------------------------------------------------------

export type DbParent = 'qsd' | 'settings';

export interface DbSpec {
  name: string;
  parent: DbParent;
  titleProp: string;
  properties: Record<string, PropSchema>;
}

export const DATABASES: DbSpec[] = [
  // — Quick Start Databases (11) ——————————————————————————————————————
  { name: 'Abstract Process Flows', parent: 'qsd', titleProp: 'Abstract Process Flow', properties: {} },
  { name: 'Process Flows',          parent: 'qsd', titleProp: 'Process Flow',          properties: { Description: RT() } },
  {
    name: 'Waterfall Tasks',
    parent: 'qsd',
    titleProp: 'Task',
    properties: {
      'Task Id': RT(),
      'Task Notes': RT(),
      Type: SEL('Extension', 'Integration', 'Migration', 'Reports'),
      Status: RT(),
      'Is Complete': CB(),
      'Progress Percent': N(),
      'Story Points': N(),
      'Start Date': D(),
      'Due Date': D(),
    },
  },
  {
    name: 'Issues',
    parent: 'qsd',
    titleProp: 'Issue',
    properties: {
      'Issue Id': RT(),
      'Issue Notes': RT(),
      Status: RT(),
      Priority: RT(),
      'Is Complete': CB(),
      'Progress Percent': N(),
      'Story Points': N(),
      'Start Date': D(),
      'Due Date': D(),
    },
  },
  {
    name: 'Milestones',
    parent: 'qsd',
    titleProp: 'Milestone',
    properties: {
      Description: RT(),
      Sequence: N(),
      'Start Date': D(),
      'End Date': D(),
      'Milestone Type': SEL(
        'Project Launch',
        'Sprint',
        'CRP',
        'Go-live',
        'Hypercare',
        'Other',
        'Not Defined',
      ),
    },
  },
  {
    name: 'Sprints',
    parent: 'qsd',
    titleProp: 'Sprint',
    properties: {
      'Sprint Code': RT(),
      'Start Date': D(),
      'End Date': D(),
      'Show & Tell Date': D(),
    },
  },
  {
    name: 'Project Members',
    parent: 'qsd',
    titleProp: 'Name',
    properties: {
      Email: RT(),
      Role: RT(),
      'Is Sunrise': CB(),
      'Notion User': PEOPLE(),
    },
  },
  {
    name: 'Sprint Goals',
    parent: 'qsd',
    titleProp: 'Goal',
    properties: { Status: RT(), Notes: RT(), 'Is Complete': CB() },
  },
  {
    name: 'Project Notes',
    parent: 'qsd',
    titleProp: 'Notes',
    properties: { Type: RT(), Status: RT(), 'Created Date': D() },
  },
  {
    name: 'Phases',
    parent: 'qsd',
    titleProp: 'Phase Code',
    properties: { Description: RT(), 'Start Date': D(), 'End Date': D() },
  },
  {
    name: 'Subtasks',
    parent: 'qsd',
    titleProp: 'Subtask Id',
    properties: {
      'Subtask Name': RT(),
      Notes: RT(),
      'Story Points': N(),
      'Start Date': D(),
      'Due Date': D(),
      Status: SEL(),
      'Subtask Type': SEL(),
      'Development Group': SEL(),
      'Task Type': SEL('Not started', 'In progress', 'Done'),
    },
  },
  // — Under Settings (3) ———————————————————————————————————————————————
  {
    name: 'Meetings',
    parent: 'settings',
    titleProp: 'Meeting',
    properties: {
      Date: D(),
      Type: SEL('Shadowing Session', 'Review Session', 'Rehearsal', 'Show & Tell'),
    },
  },
  {
    name: 'Notes',
    parent: 'settings',
    titleProp: 'Note Title',
    properties: {
      Date: D(),
      Type: SEL('Shadowing Questions', 'Design', 'Cutover Tasks'),
    },
  },
  {
    name: 'Transcripts',
    parent: 'settings',
    titleProp: 'Title',
    properties: {
      Date: D(),
      'Audio Recording': URL_(),
      Transcript: URL_(),
      Complete: CB(),
      Attendees: MS(),
    },
  },
];

// ---------------------------------------------------------------------------
// Relations: [fromDbName, propertyName, toDbName].
// All single_property — convert to dual in the Notion UI later if you want
// auto-syncing inverses.
// ---------------------------------------------------------------------------

export const RELATIONS: Array<[string, string, string]> = [
  ['Abstract Process Flows', 'Process Flows',         'Process Flows'],
  ['Abstract Process Flows', 'Waterfall Tasks',       'Waterfall Tasks'],
  ['Abstract Process Flows', 'Meetings',              'Meetings'],

  ['Process Flows',          'Owner',                 'Project Members'],
  ['Process Flows',          'Phase',                 'Phases'],
  ['Process Flows',          'Abstract Process Flow', 'Abstract Process Flows'],
  ['Process Flows',          'Sprint Goals',          'Sprint Goals'],
  ['Process Flows',          'Notes',                 'Notes'],

  ['Waterfall Tasks',        'Assigned To',           'Project Members'],
  ['Waterfall Tasks',        'Milestone',             'Milestones'],
  ['Waterfall Tasks',        'Phase',                 'Phases'],
  ['Waterfall Tasks',        'Abstract Process Flow', 'Abstract Process Flows'],
  ['Waterfall Tasks',        'Notes',                 'Notes'],

  ['Issues',                 'Assigned To',           'Project Members'],
  ['Issues',                 'Milestone',             'Milestones'],
  ['Issues',                 'Phase',                 'Phases'],
  ['Issues',                 'Abstract Process Flow', 'Abstract Process Flows'],
  ['Issues',                 'Notes',                 'Notes'],

  ['Sprints',                'Sprint Goals',          'Sprint Goals'],

  ['Milestones',             'Phase',                 'Phases'],
  ['Milestones',             'Issues',                'Issues'],
  ['Milestones',             'Notes',                 'Notes'],
  ['Milestones',             'Waterfall Tasks',       'Waterfall Tasks'],

  ['Project Members',        'Process Flows',         'Process Flows'],
  ['Project Members',        'Sprint Goals',          'Sprint Goals'],
  ['Project Members',        'Waterfall Tasks',       'Waterfall Tasks'],
  ['Project Members',        'Meetings',              'Meetings'],

  ['Notes',                  'Process Flows',         'Process Flows'],
  ['Notes',                  'Waterfall Tasks',       'Waterfall Tasks'],
  ['Notes',                  'Milestones',            'Milestones'],

  ['Sprint Goals',           'Owner',                 'Project Members'],
  ['Sprint Goals',           'Sprints',               'Sprints'],
  ['Sprint Goals',           'Phase',                 'Phases'],
  ['Sprint Goals',           'Process Flows',         'Process Flows'],

  ['Subtasks',               'Assigned To',           'Project Members'],
  ['Subtasks',               'Waterfall Task',        'Waterfall Tasks'],
  ['Subtasks',               'Issue',                 'Issues'],

  ['Meetings',               'Abstract Process Flows', 'Abstract Process Flows'],
  ['Meetings',               'Transcript',             'Transcripts'],
  ['Meetings',               'Meeting Attendees',      'Project Members'],

  ['Transcripts',            'Meeting',                'Meetings'],
];

// ---------------------------------------------------------------------------
// Sub-pages under the Waterfall Tasks resource page.
// `linkTarget: 'self'` means link to the Waterfall Tasks DB; `'issues'`
// means link to the Issues DB instead.
// ---------------------------------------------------------------------------

export interface SubPageSpec {
  name: string;
  filter: string | null;
  icon: string;
  linkTarget: 'self' | 'issues';
}

export const WATERFALL_SUBPAGES: SubPageSpec[] = [
  { name: 'Extensions',   filter: 'Extension',   icon: '⚡', linkTarget: 'self' },
  { name: 'Integrations', filter: 'Integration', icon: '🔌', linkTarget: 'self' },
  { name: 'Migrations',   filter: 'Migration',   icon: '📦', linkTarget: 'self' },
  { name: 'Reports',      filter: 'Reports',     icon: '📊', linkTarget: 'self' },
  { name: 'Issues',       filter: null,          icon: '🐛', linkTarget: 'issues' },
];

// ---------------------------------------------------------------------------
// Block builders for the Project Home structural content + sub-pages.
// Loosely typed (`unknown`) so the SDK accepts them via `as never`.
// ---------------------------------------------------------------------------

const text = (content: string, italic = false) => ({
  type: 'text' as const,
  text: { content },
  ...(italic ? { annotations: { italic: true } } : {}),
});

export const heading1 = (t: string) => ({
  type: 'heading_1' as const,
  heading_1: { rich_text: [text(t)] },
});
export const heading2 = (t: string) => ({
  type: 'heading_2' as const,
  heading_2: { rich_text: [text(t)] },
});
export const divider = () => ({ type: 'divider' as const, divider: {} });
export const paragraph = (t: string, italic = false) => ({
  type: 'paragraph' as const,
  paragraph: { rich_text: [text(t, italic)] },
});
export const linkPage = (id: string) => ({
  type: 'link_to_page' as const,
  link_to_page: { type: 'page_id' as const, page_id: id },
});
export const linkDb = (id: string) => ({
  type: 'link_to_page' as const,
  link_to_page: { type: 'database_id' as const, database_id: id },
});
export const column = (children: unknown[]) => ({
  type: 'column' as const,
  column: { children },
});
export const columnList = (cols: unknown[]) => ({
  type: 'column_list' as const,
  column_list: { children: cols },
});
