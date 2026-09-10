// Touch-first multi-select on the board, and handing the selection to one goal run.
// Run only against an isolated demo server with telemetry disabled:
//   XDG_CONFIG_HOME=/tmp/scotty-selection POSTHOG_KEY='' BEADS_DEMO=1 SCOTTY_READ_ONLY=1 npm run start -- --port 3198
//   SCOTTY_TEST_URL=http://localhost:3198 node scripts/test-board-selection.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated demo server');
assert.equal((await (await fetch(`${base}/api/telemetry`)).json()).configured, false);

const bead = (id, extra = {}) => ({ id, title: id, status: 'open', issue_type: 'task', priority: 1,
  labels: [], dependencies: [], created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-08T00:00:00Z', ...extra });
const beads = [
  bead('one'), bead('two'), bead('three'),
  bead('flying', { status: 'in_progress' }),
  bead('shipped', { status: 'closed', closed_at: '2026-09-07T00:00:00Z' }),
];

let started = null;
const browser = await chromium.launch();
try {
  // Phone width: the whole point of select mode is that it works on touch.
  const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/p/demo/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/beads/stream')) return route.abort();
    if (path.endsWith('/goal')) {
      if (req.method() === 'POST') {
        started = JSON.parse(req.postData()).ids;
        const run = { id: 'ab12cd34', cwd: '/tmp/x', state: 'blocked', startedAt: Date.now(), live: true };
        return route.fulfill({ status: 202, json: { run, ids: started } });
      }
      return route.fulfill({ json: { runs: [], active: null } });
    }
    if (path.endsWith('/beads')) return route.fulfill({ json: { beads, meta: {
      kind: 'demo', readOnly: false, pollIntervalMs: 1000, lanePrefix: null,
      humanActor: 'chris', humanAllowlist: ['chris'],
    } } });
    return route.fulfill({ json: beads.find(b => path.endsWith(`/beads/${b.id}`)) ?? {} });
  });

  // The documented isolated server starts read-only; unlock this browser session
  // only, the way the board sorting checks do.
  const unlock = await page.context().request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });
  assert.equal(unlock.status(), 200, 'isolated demo can be unlocked for mutation assertions');

  await page.goto(`${base}/p/demo?view=board`);
  const selectToggle = page.getByRole('button', { name: 'Select', exact: true });
  await selectToggle.waitFor();
  assert.equal(await selectToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.getByRole('region', { name: 'Selected beads' }).count(), 0);

  const card = id => page.locator(`[data-keyboard-bead-id="${id}"]`);

  // Off by default: a tap opens the bead, as it always did.
  await card('one').tap();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');

  await selectToggle.tap();
  assert.equal(await selectToggle.getAttribute('aria-pressed'), 'true');
  const bar = page.getByRole('region', { name: 'Selected beads' });
  await bar.waitFor();
  await page.getByText('Tap beads to add them to a goal run').waitFor();

  // In select mode a tap picks the bead instead of opening it.
  await card('one').tap();
  await card('three').tap();
  await card('flying').tap();
  assert.equal(await page.getByRole('dialog').count(), 0, 'select mode must not open beads');
  await bar.getByText('3 selected').waitFor();
  assert.equal(await card('one').getAttribute('aria-pressed'), 'true');
  assert.equal(await card('two').getAttribute('aria-pressed'), 'false');

  // Tapping again removes it.
  await card('three').tap();
  await bar.getByText('2 selected').waitFor();

  // A closed bead has no work left: it stays openable, never selectable.
  assert.equal(await card('shipped').getAttribute('aria-pressed'), null);
  await card('shipped').tap();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await bar.getByText('2 selected').waitFor();

  // The bar is reachable without scrolling sideways at 390px.
  const box = await bar.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `action bar fits the viewport: ${JSON.stringify(box)}`);
  assert.equal(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
    'the page itself must not scroll horizontally');

  // Launch: confirm first, then POST exactly the selected ids.
  await bar.getByRole('button', { name: /^Run goal/ }).tap();
  await page.getByText('Start a goal run on 2 beads?').waitFor();
  await page.getByRole('button', { name: 'Start run' }).tap();
  await page.getByText('Goal run ab12cd34 started on 2 beads').waitFor();
  assert.deepEqual([...started].sort(), ['flying', 'one'], 'posts the selection, nothing else');

  // Clear empties the set without leaving select mode.
  await bar.getByRole('button', { name: 'Clear' }).tap();
  await bar.getByText('0 selected').waitFor();
  assert.equal(await selectToggle.getAttribute('aria-pressed'), 'true');

  // Leaving select mode drops the selection and the bar.
  await card('two').tap();
  await bar.getByText('1 selected').waitFor();
  await selectToggle.tap();
  assert.equal(await page.getByRole('region', { name: 'Selected beads' }).count(), 0);
  await selectToggle.tap();
  await bar.getByText('0 selected').waitFor();

  assert.deepEqual(errors, [], 'no page errors');
  console.log('test-board-selection: passed');
} finally {
  await browser.close();
}
