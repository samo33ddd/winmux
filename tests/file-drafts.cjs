const assert = require('node:assert/strict');
const { test } = require('node:test');

test('saving survives remounts, retains newer edits and removes closed owners', async () => {
  const store = await import('../src/fileDrafts.ts');
  const key = JSON.stringify(['w', 'p', 'cwd', 'file.txt']);
  store.setFileDraft(key, { text:'first edit', expectedText:'original' });
  let finish;
  const saving = store.saveFileDraft(key, () => new Promise(resolve => { finish = resolve; }));
  assert.equal(store.getFileDraft(key).saving, true, 'reopened editor sees the shared save lock');
  assert.throws(() => store.assertFilesNotSaving(['p']), /Wait for the file/);
  store.setFileDraft(key, { text:'newer edit', expectedText:'original' });
  finish(); await saving;
  assert.equal(store.getFileDraft(key).text, 'newer edit', 'an old response cannot erase a new draft');
  assert.equal(store.hasUnsavedFiles(), true);
  store.pruneFileDrafts([{ id:'w', panes:[] }]);
  assert.equal(store.hasUnsavedFiles(), false, 'closing its pane removes the unload blocker');
  store.setFileDraft(key, { text:'saved', expectedText:'old' });
  await store.saveFileDraft(key, async () => {});
  assert.equal(store.hasUnsavedFiles(), false);
  store.pruneFileDrafts([]);
});
