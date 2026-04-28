import type { Config } from './types.js';

export const QUICKSTART_TEMPLATE_YAML = `version: 1
notion:
  teamspaceId: REPLACE_WITH_TEAMSPACE_UUID
  rootPageId: REPLACE_WITH_PROJECT_HOME_PAGE_UUID

defaultDirection: both
commitStrategy: direct
conflictPolicy: abort

mappings:
  - notion: "Process Flows"
    local: docs/process-flows
  - notion: "Waterfall Tasks"
    local: projectmanagement/waterfall-tasks
  - notion: "Project Definition"
    local: docs/project-definition
  - notion: "Features"
    local: docs/features
    optional: true
  - notion: "Resources"
    local: docs/resources
  - notion: "Miscellaneous"
    local: docs/misc

  - notion: "Meetings"
    local: projectmanagement/meetings
    type: database
  - notion: "PM Tasks"
    local: projectmanagement/pm-tasks
    type: database
    commitStrategy: pr
    direction: pull

notionIgnore:
  - "Settings"
  - "Task Execution Log"

localIgnore:
  - implementation/**
  - powerbi/**
  - tools/**
  - "**/*.al"
  - "**/*.json"
  - "**/*.csv"
  - "**/.gitkeep"
  - .sync-state.json

markdown:
  frontmatter: true
  attachments: .attachments
`;

export function makeDefaultConfig(teamspaceId: string, rootPageId: string): Config {
  return {
    version: 1,
    notion: { teamspaceId, rootPageId },
    defaultDirection: 'both',
    commitStrategy: 'direct',
    conflictPolicy: 'abort',
    mappings: [
      { notion: 'Process Flows', local: 'docs/process-flows', type: 'page', optional: false },
      { notion: 'Waterfall Tasks', local: 'projectmanagement/waterfall-tasks', type: 'page', optional: false },
      { notion: 'Project Definition', local: 'docs/project-definition', type: 'page', optional: false },
      { notion: 'Features', local: 'docs/features', type: 'page', optional: true },
      { notion: 'Resources', local: 'docs/resources', type: 'page', optional: false },
      { notion: 'Miscellaneous', local: 'docs/misc', type: 'page', optional: false },
      { notion: 'Meetings', local: 'projectmanagement/meetings', type: 'database', optional: false },
      {
        notion: 'PM Tasks',
        local: 'projectmanagement/pm-tasks',
        type: 'database',
        commitStrategy: 'pr',
        direction: 'pull',
        optional: false,
      },
    ],
    notionIgnore: ['Settings', 'Task Execution Log'],
    localIgnore: [
      'implementation/**',
      'powerbi/**',
      'tools/**',
      '**/*.al',
      '**/*.json',
      '**/*.csv',
      '**/.gitkeep',
      '.sync-state.json',
    ],
    markdown: { frontmatter: true, attachments: '.attachments' },
  };
}
