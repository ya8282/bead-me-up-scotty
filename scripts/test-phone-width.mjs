// The app shell at phone width: the sidebar collapses behind a toggle, the
// board takes the full width, and Select plus the selection bar stay reachable
// without horizontal scrolling. Desktop must keep working with no toggle at all.
// Run only against an isolated demo server with telemetry disabled:
//   XDG_CONFIG_HOME=/tmp/scotty-phone POSTHOG_KEY='' BEADS_DEMO=1 SCOTTY_READ_ONLY=1 npm run start -- --port 3199
//   SCOTTY_TEST_URL=http://localhost:3199 node scripts/test-phone-width.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated demo server');
assert.equal((await (await fetch(`${base}/api/telemetry`)).json()).configured, false);

const bead = (id, extra = {}) => ({ id, title: id, status: 'open', issue_type: 'task', priority: 1,
  labels: [], dependencies: [], created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-08T00:00:00Z', ...extra });
const beads = [bead('one'), bead('two'), bead('three')];

const browser = await chromium.launch();
try {
  const mockApi = async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/beads/stream')) return route.abort();
    if (path.endsWith('/goal')) return route.fulfill({ json: { runs: [], active: null } });
    if (path.endsWith('/beads')) return route.fulfill({ json: { beads, meta: {
      kind: 'demo', readOnly: false, pollIntervalMs: 1000, lanePrefix: null,
      humanActor: 'chris', humanAllowlist: ['chris'],
    } } });
    return route.fulfill({ json: beads.find((b) => path.endsWith(`/beads/${b.id}`)) ?? {} });
  };
  // Matches the isolated demo server's own read-only default (unlocked per
  // browser session, the way the board selection and sorting checks do).
  const openBoard = async (options) => {
    const p = await browser.newPage(options);
    await p.route('**/api/p/demo/**', mockApi);
    const unlock = await p.context().request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });
    assert.equal(unlock.status(), 200, 'isolated demo can be unlocked for mutation assertions');
    await p.goto(`${base}/p/demo?view=board`);
    return p;
  };

  // Desktop: the sidebar is just there, no toggle needed, so this change
  // cannot silently break the layout everyone actually works in day to day.
  const desktop = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await desktop.route('**/api/p/demo/**', mockApi);
  await desktop.goto(`${base}/p/demo?view=board`);
  await desktop.getByRole('navigation').getByRole('button', { name: 'Board', exact: true }).waitFor();
  assert.equal(await desktop.getByRole('button', { name: 'Open navigation' }).count(), 0,
    'no mobile toggle at desktop width');
  await desktop.close();

  // Phone: the nav starts closed, opens on demand, and closes itself again
  // once a view is picked — landing on a view with the nav still covering it
  // is the main way this kind of change ships broken.
  const page = await openBoard({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  assert.equal(await page.getByRole('navigation').count(), 0, 'nav is off-canvas until opened');
  const toggle = page.getByRole('button', { name: 'Open navigation' });
  await toggle.waitFor();

  await toggle.click();
  const nav = page.getByRole('navigation');
  await nav.waitFor();
  const boardLink = nav.getByRole('button', { name: 'Board', exact: true });
  await boardLink.waitFor();

  // Picking a view closes the sheet: it must not still cover the view it just opened.
  // The sheet unmounts only once its close transition finishes, so wait it out
  // rather than racing the animation.
  await nav.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('heading', { name: 'List' }).waitFor();
  await nav.waitFor({ state: 'detached' });

  // Back to Board to check width and the selection flow.
  await toggle.click();
  await page.getByRole('navigation').getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('heading', { name: 'Board' }).waitFor();
  await page.getByRole('navigation').waitFor({ state: 'detached' });

  assert.equal(
    await page.evaluate(() => document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth),
    true,
    'no horizontal scrolling at 390px',
  );

  const selectToggle = page.getByRole('button', { name: 'Select', exact: true });
  await selectToggle.waitFor();
  let box = await selectToggle.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `Select is on screen at 390px: ${JSON.stringify(box)}`);
  await selectToggle.tap();

  const card = (id) => page.locator(`[data-keyboard-bead-id="${id}"]`);
  await card('one').tap();
  const bar = page.getByRole('region', { name: 'Selected beads' });
  await bar.waitFor();
  box = await bar.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `selection bar is on screen at 390px: ${JSON.stringify(box)}`);
  await bar.getByText('1 selected').waitFor();

  assert.deepEqual(errors, [], 'no page errors');
  console.log('test-phone-width: passed');
} finally {
  await browser.close();
}
