// Regression check for the push path against pages holding Notion blocks
// the API refuses to touch for integration bots (AI blocks surface as type
// `unsupported`). Run with `npm test` (builds first, then node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToBlocks } from '../dist/markdown/toBlocks.js';
import { replacePageBlocks } from '../dist/sync/push.js';

const UNSUPPORTED_ERROR = 'Block type ai_block is not supported via the API for your bot type.';

// Stub of the @notionhq/client surface replacePageBlocks touches. Any call
// against the AI block's id throws the way Notion does.
function stubClient(existing) {
  const calls = { listed: [], deleted: [], appended: [] };
  const guard = (id) => {
    const hit = existing.find((b) => b.id === id);
    if (hit?.type === 'unsupported') throw new Error(UNSUPPORTED_ERROR);
  };
  const client = {
    blocks: {
      children: {
        list: async ({ block_id }) => {
          calls.listed.push(block_id);
          if (block_id === 'page') return { results: existing, has_more: false, next_cursor: null };
          guard(block_id);
          return { results: [], has_more: false, next_cursor: null };
        },
        append: async ({ block_id, children }) => {
          calls.appended.push({ block_id, children });
          return {};
        },
      },
      delete: async ({ block_id }) => {
        guard(block_id);
        calls.deleted.push(block_id);
        return {};
      },
    },
  };
  return { client, calls };
}

test('pull placeholder for an unsupported block produces no block on push', () => {
  const body = '# Procure to Pay\n\n<!-- unsupported block: unsupported -->\n\nSome text.\n';
  const blocks = markdownToBlocks(body);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading_1', 'paragraph'],
  );
});

test('replacePageBlocks leaves `unsupported` blocks untouched and still replaces the rest', async () => {
  const existing = [
    { id: 'p1', type: 'paragraph', has_children: false },
    { id: 'ai', type: 'unsupported', has_children: true },
    { id: 'p2', type: 'paragraph', has_children: false },
  ];
  const { client, calls } = stubClient(existing);
  const fresh = markdownToBlocks('New content.\n');

  await replacePageBlocks(client, 'page', fresh);

  assert.ok(!calls.listed.includes('ai'), 'must not list children of the unsupported block');
  assert.deepEqual(calls.deleted, ['p1', 'p2']);
  assert.equal(calls.appended.length, 1);
  assert.deepEqual(calls.appended[0].children, fresh);
});

test('a block whose children cannot be inspected is preserved, not deleted', async () => {
  // A container Notion refuses to open for us: we cannot prove it holds no
  // page/database, so it must survive the replace.
  const existing = [{ id: 'opaque', type: 'toggle', has_children: true }];
  const { client, calls } = stubClient(existing);
  client.blocks.children.list = async ({ block_id }) => {
    calls.listed.push(block_id);
    if (block_id === 'page') return { results: existing, has_more: false, next_cursor: null };
    throw new Error(UNSUPPORTED_ERROR);
  };

  await replacePageBlocks(client, 'page', []);

  assert.deepEqual(calls.deleted, []);
});
