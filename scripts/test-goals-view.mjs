// The Goals view: watching goal runs from inside Scotty.
// Run only against an isolated demo server with telemetry disabled:
//   XDG_CONFIG_HOME=/tmp/scotty-goals POSTHOG_KEY='' BEADS_DEMO=1 SCOTTY_READ_ONLY=1 npm run start -- --port 3198
//   SCOTTY_TEST_URL=http://localhost:3198 node scripts/test-goals-view.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated demo server');
assert.equal((await (await fetch(`${base}/api/telemetry`)).json()).configured, false);

const now = Date.now();
const waiting = { id: 'ab12cd34', cwd: '/r', state: 'blocked', startedAt: now - 60_000, name: 'goal score viewer', live: true };
const finished = { id: '99ee88dd', cwd: '/r', state: 'done', startedAt: now - 3_600_000, name: 'earlier run', live: false };
const at = (s) => new Date(now - 50_000 + s * 1000).toISOString();
const feeds = {
  ab12cd34: {
    items: [
      { id: '1', at: at(0), source: 'main', kind: 'command', text: '/goal score-viewer repo-tyw9' },
      { id: '2', at: at(1), source: 'main', kind: 'text', text: 'Four beads need a decision.' },
      { id: '3', at: at(2), source: 'implementer: repo-7sm3.3 Linux firefox failures', kind: 'tool', text: 'Read: /tmp/probe-firefox.log' },
    ],
    screen: 'repo-tyw9: Which fix?\n❯ 1. Close the sheet\n  2. Raise the scrim',
  },
  '99ee88dd': {
    items: [
      { id: '9', at: at(3), source: 'main', kind: 'text', text: 'All done.' },
      {
        id: '10',
        at: at(4),
        source: 'main',
        kind: 'text',
        text: '| Bead | Result |\n| --- | --- |\n| repo-tyw9 | closed |\n| 0p2l.4 | deferred |',
      },
      { id: '11', at: at(5), source: 'main', kind: 'tool', text: 'Bash: echo "| not | a table |"' },
    ],
    screen: null,
  },
};
let runs = [waiting, finished];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/p/demo/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/beads/stream')) return route.abort();
    const feed = path.match(/\/goal\/([0-9a-f]+)$/);
    if (feed) {
      const run = runs.find((r) => r.id === feed[1]);
      return run
        ? route.fulfill({ json: { run, ...feeds[run.id] } })
        : route.fulfill({ status: 404, json: { error: 'There is no goal run here.', code: 'unknown_run' } });
    }
    if (path.endsWith('/goal')) return route.fulfill({ json: { runs, active: runs.find((r) => r.live) ?? null } });
    if (path.endsWith('/beads')) return route.fulfill({ json: { beads: [], meta: {
      kind: 'bd', readOnly: false, pollIntervalMs: 1000, lanePrefix: null, humanActor: 'chris', humanAllowlist: ['chris'],
    } } });
    return route.fulfill({ json: {} });
  });

  // From the board, a waiting run is visible in the nav before opening anything.
  await page.goto(`${base}/p/demo?view=board`);
  const nav = page.getByRole('button', { name: /^Goals/ });
  await nav.waitFor();
  await nav.getByText('waiting').waitFor();

  // G then W opens it, like every other view.
  await page.locator('body').click({ position: { x: 700, y: 600 } });
  await page.keyboard.press('g');
  await page.keyboard.press('w');
  await page.getByRole('heading', { name: 'Goals' }).waitFor();

  // Runs newest first; the newest is shown until another is picked.
  const runButtons = page.getByRole('navigation', { name: 'Goal runs' }).getByRole('button');
  assert.equal(await runButtons.count(), 2);
  assert.match(await runButtons.nth(0).innerText(), /ab12cd34[\s\S]*waiting on you/);
  assert.equal(await runButtons.nth(0).getAttribute('aria-current'), 'true');

  // The feed: labelled by kind, with subagent work tagged by its source.
  const output = page.getByRole('region', { name: 'Run output' });
  const rows = output.getByRole('list', { name: 'Feed' }).getByRole('listitem');
  await rows.nth(2).waitFor();
  assert.equal(await rows.count(), 3);
  assert.match(await rows.nth(0).innerText(), /Started[\s\S]*\/goal score-viewer repo-tyw9/);
  assert.match(await rows.nth(2).innerText(), /Runs[\s\S]*implementer: repo-7sm3\.3[\s\S]*Read: \/tmp\/probe-firefox\.log/);
  await output.getByText('claude attach ab12cd34').first().waitFor();

  // Blocked: the question is readable here, not only in a terminal.
  // No choices could be parsed from this screen, so it is shown as-is.
  const ask = output.getByRole('region', { name: 'Goal run ab12cd34 is asking' });
  await ask.getByText('❯ 1. Close the sheet', { exact: false }).waitFor();
  await ask.getByText('can’t read any choices', { exact: false }).waitFor();

  // Live: new output arrives without a reload.
  feeds.ab12cd34.items.push({ id: '4', at: at(4), source: 'main', kind: 'text', text: 'Answer received, carrying on.' });
  await output.getByText('Answer received, carrying on.').waitFor({ timeout: 8000 });

  // Picking an earlier run shows its feed, and nothing is waiting there.
  await runButtons.nth(1).click();
  await output.getByText('All done.').waitFor();

  // What the run says is markdown: a GFM table becomes a real table.
  const table = output.getByRole('table');
  await table.waitFor();
  assert.deepEqual(await table.getByRole('columnheader').allInnerTexts(), ['Bead', 'Result']);
  assert.match(await table.innerText(), /repo-tyw9[\s\S]*closed/);
  // A tool line is argv, not prose, so its pipes stay literal.
  assert.equal(await output.getByRole('table').count(), 1);
  await output.getByText('Bash: echo "| not | a table |"').waitFor();
  assert.equal(await output.getByRole('region', { name: /is asking$/ }).count(), 0);
  assert.equal(await output.getByText('Four beads need a decision.').count(), 0);

  // No runs at all: say how to start one.
  runs = [];
  await page.reload();
  await page.getByText('No goal runs in this project yet.', { exact: false }).waitFor();

  assert.deepEqual(errors, [], 'no page errors');
  console.log('test-goals-view: passed');
} finally {
  await browser.close();
}
