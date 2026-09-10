// Board grouping by epic, and the per-epic Run goal action.
// Run only against an isolated demo server with telemetry disabled:
//   XDG_CONFIG_HOME=/tmp/scotty-grouping POSTHOG_KEY='' BEADS_DEMO=1 npm run start -- --port 3198
//   SCOTTY_TEST_URL=http://localhost:3198 node scripts/test-board-grouping.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated demo server');
assert.equal((await (await fetch(`${base}/api/telemetry`)).json()).configured, false);

const bead = (id, extra = {}) => ({ id, title: id, status: 'open', issue_type: 'task', priority: 1,
  labels: [], dependencies: [], created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-08T00:00:00Z', ...extra });
const child = (id, parent, extra = {}) =>
  bead(id, { dependencies: [{ type: 'parent-child', depends_on_id: parent }], ...extra });

const beads = [
  bead('epic-alpha', { issue_type: 'epic', title: 'Alpha epic' }),
  bead('epic-omega', { issue_type: 'epic', title: 'Omega epic' }),
  bead('epic-shipped', { issue_type: 'epic', title: 'Shipped epic' }),
  bead('parent-task', { title: 'A task with children' }),
  // Alpha: open, in-flight and closed children — the closed one must not be runnable.
  child('alpha-open', 'epic-alpha'),
  child('alpha-flight', 'epic-alpha', { status: 'in_progress' }),
  child('alpha-done', 'epic-alpha', { status: 'closed', closed_at: '2026-09-07T00:00:00Z' }),
  // Omega sorts after Alpha by label.
  child('omega-open', 'epic-omega'),
  // Every child closed, so the row is hidden.
  child('shipped-done', 'epic-shipped', { status: 'closed', closed_at: '2026-09-07T00:00:00Z' }),
  // Parented by a task rather than an epic: still its own row.
  child('task-child', 'parent-task'),
  // No parent at all.
  bead('orphan'),
];

let goalRuns = { runs: [], active: null };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/p/demo/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/beads/stream')) return route.abort();
    if (path.endsWith('/goal')) return route.fulfill({ json: goalRuns });
    if (path.endsWith('/beads')) return route.fulfill({ json: { beads, meta: {
      kind: 'demo', readOnly: false, pollIntervalMs: 1000, lanePrefix: null,
      humanActor: 'chris', humanAllowlist: ['chris'],
    } } });
    return route.fulfill({ json: beads.find(b => path.endsWith(`/beads/${b.id}`)) ?? {} });
  });

  await page.goto(`${base}/p/demo?view=board`);
  const group = page.getByRole('combobox', { name: 'Group board rows' });
  await group.waitFor();

  // Flat by default: grouping is a preference, not a new default.
  assert.equal(await group.inputValue(), 'none', 'board starts ungrouped');
  assert.equal(await page.getByRole('region', { name: /^Epic: / }).count(), 0);

  await group.selectOption('epic');
  const row = label => page.getByRole('region', { name: `Epic: ${label}`, exact: true });
  await row('Alpha epic').waitFor();

  // One row per parent, epics and tasks alike; all-closed rows are hidden.
  const labels = await page.getByRole('region', { name: /^Epic: / })
    .evaluateAll(els => els.map(e => e.getAttribute('aria-label').replace('Epic: ', '')));
  assert.deepEqual(labels, ['A task with children', 'Alpha epic', 'Omega epic', 'No epic'],
    'rows sort alphabetically with parentless work last');
  assert.equal(await row('Shipped epic').count(), 0, 'a fully closed epic is hidden');

  // Cards land in their own row, and only there.
  const cards = label => row(label).locator('[data-keyboard-bead-id]')
    .evaluateAll(els => els.map(e => e.dataset.keyboardBeadId));
  assert.deepEqual((await cards('Alpha epic')).sort(), ['alpha-done', 'alpha-flight', 'alpha-open']);
  assert.deepEqual(await cards('Omega epic'), ['omega-open']);
  // parent-task labels its own row AND sits in the parentless row: it is not an
  // epic, so it stays a card on the board, and it has no parent of its own.
  assert.deepEqual((await cards('No epic')).sort(), ['orphan', 'parent-task']);
  assert.deepEqual(await cards('A task with children'), ['task-child']);
  // An epic is a container: it never appears as a card on the board.
  assert.equal(await page.locator('[data-keyboard-bead-id="epic-alpha"]').count(), 0);

  // Run goal offers the row's open beads only — closed ones are not work.
  const runGoal = label => row(label).getByRole('button', { name: /^Run goal/ });
  assert.equal(await runGoal('Alpha epic').getAttribute('aria-label'),
    'Run goal on epic (2 beads)', 'closed children are excluded from the set');
  assert.equal(await runGoal('Alpha epic').isEnabled(), true);

  // Confirm before launching, showing the exact set the run will fix.
  await runGoal('Alpha epic').click();
  await page.getByText('Start a goal run on 2 beads?').waitFor();
  const listed = await page.getByRole('dialog').locator('li')
    .evaluateAll(els => els.map(e => e.textContent).sort());
  assert.deepEqual(listed, ['alpha-flight', 'alpha-open']);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // A live run owns the working tree, so every launcher is refused.
  goalRuns = { runs: [{ id: 'ab12cd34', cwd: '/tmp/x', state: 'blocked', startedAt: Date.now(), live: true }],
    active: { id: 'ab12cd34', cwd: '/tmp/x', state: 'blocked', startedAt: Date.now(), live: true } };
  await page.reload();
  await group.waitFor();
  assert.equal(await group.inputValue(), 'epic', 'the grouping choice survives a reload');
  await page.getByText('is waiting for a decision', { exact: false }).waitFor();
  await page.getByText('claude attach ab12cd34').waitFor();
  await row('Alpha epic').waitFor();
  assert.equal(await runGoal('Alpha epic').isDisabled(), true,
    'no second run while one holds the tree');
  assert.match(await runGoal('Alpha epic').getAttribute('title'), /ab12cd34/);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('test-board-grouping: passed');
} finally {
  await browser.close();
}
