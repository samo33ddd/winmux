const assert = require('node:assert/strict');
const { test } = require('node:test');

test('saving survives remounts, retains newer edits and keeps a dirty draft after owner loss', async () => {
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

  // The pane disappears with dirty text: the draft is retained as an orphan,
  // and hasUnsavedFiles keeps blocking window close until it is discarded.
  store.pruneFileDrafts([{ id:'w', panes:[] }]);
  assert.equal(store.hasUnsavedFiles(), true, 'a dirty draft must not be dropped with its owner');
  const orphans = store.getOrphanedFileDrafts();
  assert.equal(orphans.length, 1, 'the orphan is recoverable');
  assert.equal(orphans[0].key, key);
  assert.equal(orphans[0].draft.text, 'newer edit', 'orphan retains the exact bytes');
  assert.equal(orphans[0].draft.orphaned, true);

  // Only that key is removed by an explicit discard.
  const other = JSON.stringify(['w', 'p2', 'cwd', 'other.txt']);
  store.setFileDraft(other, { text:'other edit', expectedText:'orig' });
  store.pruneFileDrafts([]);
  assert.equal(store.getOrphanedFileDrafts().length, 2, 'a second dirty draft is also retained');
  store.setFileDraft(key);
  assert.equal(store.getFileDraft(key), undefined, 'discard removes only its key');
  assert.equal(store.getFileDraft(other).text, 'other edit');
  assert.equal(store.getOrphanedFileDrafts().length, 1);
  store.setFileDraft(other);
});

test('clean drafts are pruned with their owner while dirty ones stay', async () => {
  const store = await import('../src/fileDrafts.ts');
  const clean = JSON.stringify(['w', 'p', 'cwd', 'clean.txt']);
  const dirty = JSON.stringify(['w', 'p', 'cwd', 'dirty.txt']);
  store.setFileDraft(clean, { text:'saved', expectedText:'saved' });
  store.setFileDraft(dirty, { text:'edited', expectedText:'orig' });
  store.pruneFileDrafts([]);
  assert.equal(store.getFileDraft(clean), undefined, 'a clean draft is pruned');
  assert.equal(store.getFileDraft(dirty).orphaned, true, 'a dirty draft is retained as an orphan');
  assert.equal(store.hasUnsavedFiles(), true);
  store.setFileDraft(dirty);
});

test('orphan save success and failure resolve without ghost blockers', async () => {
  const store = await import('../src/fileDrafts.ts');
  const key = JSON.stringify(['w', 'gone', 'cwd', 'pending.txt']);
  store.setFileDraft(key, { text:'edited', expectedText:'orig' });
  store.pruneFileDrafts([]);
  assert.equal(store.getFileDraft(key).orphaned, true);

  // A pending save that fails keeps the error and text recoverable.
  await store.saveFileDraft(key, async () => { throw new Error('disk full'); });
  assert.equal(store.getFileDraft(key).error, 'disk full');
  assert.equal(store.getFileDraft(key).text, 'edited');
  assert.equal(store.hasUnsavedFiles(), true);

  // A retry that succeeds clears the dirty state; the retained draft is clean
  // and is removed by the next prune, leaving no ghost blocker.
  await store.saveFileDraft(key, async () => {});
  assert.equal(store.getFileDraft(key).text, 'edited');
  assert.equal(store.hasUnsavedFiles(), false, 'a saved orphan is clean');
  store.pruneFileDrafts([]);
  assert.equal(store.getFileDraft(key), undefined, 'a clean orphan prunes normally');
});

test('getOrphanedFileDrafts snapshot is stable between unrelated updates', async () => {
  const store = await import('../src/fileDrafts.ts');
  const a = JSON.stringify(['w', 'p', 'cwd', 'a.txt']);
  const b = JSON.stringify(['w', 'p', 'cwd', 'b.txt']);
  store.setFileDraft(a, { text:'a', expectedText:'a-orig' });
  store.setFileDraft(b, { text:'b', expectedText:'b-orig' });
  store.pruneFileDrafts([]);
  const first = store.getOrphanedFileDrafts();
  const second = store.getOrphanedFileDrafts();
  assert.equal(first, second, 'the same snapshot object is returned between updates');
  // Any store update rebuilds the snapshot once; useSyncExternalStore then gets
  // a fresh array only when something actually changed.
  store.setFileDraft(JSON.stringify(['w2','q','cwd','c.txt']), { text:'x', expectedText:'x' });
  const third = store.getOrphanedFileDrafts();
  assert.notEqual(third, first, 'a store update produces a new snapshot');
  assert.deepEqual(third, first, 'with the same orphan contents');
  assert.equal(store.getOrphanedFileDrafts(), third, 'and stays stable until the next update');
  store.setFileDraft(a);
  store.setFileDraft(b);
});
