// Answering a waiting goal run from Needs You.
// Run only against an isolated demo server with telemetry disabled:
//   XDG_CONFIG_HOME=/tmp/scotty-answer POSTHOG_KEY='' BEADS_DEMO=1 SCOTTY_READ_ONLY=1 npm run start -- --port 3198
//   SCOTTY_TEST_URL=http://localhost:3198 node scripts/test-goal-answer.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated demo server');
assert.equal((await (await fetch(`${base}/api/telemetry`)).json()).configured, false);

const run = { id: 'ab12cd34', cwd: '/r', state: 'blocked', startedAt: Date.now() - 60_000, name: 'goal score viewer', live: true };
const scrimQuestion = {
  key: '1111111111111111',
  tabs: '←  ☐ tyw9 scrim  ☐ 0p2l.4 font  ✔ Submit  →',
  question: "repo-tyw9: the Score rail sheet stays open above the Export dialog's scrim. Which fix?",
  multi: false,
  options: [
    { n: 1, label: 'Close the sheet (Recommended)', detail: 'Dismiss the rail sheet when the dialog opens.', freeText: false, selected: false },
    { n: 2, label: 'Raise the scrim', detail: 'Put the scrim above the rail sheet.', freeText: false, selected: false },
    { n: 3, label: 'Type something.', detail: '', freeText: true, selected: false },
  ],
  screen: '────\nrepo-tyw9: Which fix?\n❯ 1. Close the sheet (Recommended)',
};
const fontQuestion = { ...scrimQuestion, key: '2222222222222222', question: 'repo-0p2l.4: which font?',
  options: [{ n: 1, label: 'Bravura', detail: '', freeText: false, selected: false }, { n: 2, label: 'Type something.', detail: '', freeText: true, selected: false }] };
// A multi-select: its choices are ticked rather than clicked, and one of them
// arrives already ticked on the run's screen.
const fruitQuestion = {
  key: '4444444444444444',
  tabs: '←  ☒ Fruit  ☐ Color  ✔ Submit  →',
  question: 'Which fruits should I buy?',
  multi: true,
  options: [
    { n: 1, label: 'Apple', detail: 'Crisp and versatile.', freeText: false, selected: true },
    { n: 2, label: 'Banana', detail: 'Easy to carry, no prep.', freeText: false, selected: false },
    { n: 3, label: 'Cherry', detail: 'Seasonal, sweet-tart.', freeText: false, selected: false },
    { n: 4, label: 'Type something', detail: '', freeText: true, selected: false },
  ],
  screen: '────\nWhich fruits should I buy?\n❯ 1. [✔] Apple',
};

let prompt = scrimQuestion;
let answerStatus = 200;
const answers = [];

const browser = await chromium.launch();
const open = async (unlock) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.route('**/api/p/demo/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/beads/stream')) return route.abort();
    if (path.endsWith('/goal/ab12cd34')) {
      if (req.method() === 'POST') {
        answers.push(JSON.parse(req.postData()));
        return answerStatus === 200
          ? route.fulfill({ json: { ok: true } })
          : route.fulfill({ status: 409, json: { error: "The run's question changed since this page loaded. Review the new one and answer again.", code: 'prompt_changed' } });
      }
      return route.fulfill({ json: { run, items: [], screen: prompt?.screen ?? 'Bash command\n  rm -rf build\nwaiting…', prompt } });
    }
    if (path.endsWith('/goal')) return route.fulfill({ json: { runs: [run], active: run } });
    if (path.endsWith('/beads')) return route.fulfill({ json: { beads: [], meta: {
      kind: 'bd', readOnly: false, pollIntervalMs: 1000, lanePrefix: null, humanActor: 'chris', humanAllowlist: ['chris'],
    } } });
    return route.fulfill({ json: {} });
  });
  if (unlock) {
    const res = await page.context().request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });
    assert.equal(res.status(), 200);
  }
  await page.goto(`${base}/p/demo?view=needsyou`);
  return page;
};

try {
  const page = await open(true);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // A waiting run is in Needs You, counted in the nav, first in the list.
  const card = page.getByRole('region', { name: 'Goal run ab12cd34 is asking' });
  await card.waitFor();
  await page.getByText('1 waiting on you').waitFor();
  assert.match(await page.getByRole('button', { name: /^Needs You/ }).innerText(), /1/);
  await card.getByText("Which fix?", { exact: false }).first().waitFor();
  await card.getByText('☐ tyw9 scrim', { exact: false }).waitFor();

  const choices = card.getByRole('group', { name: 'Choices' }).getByRole('button');
  assert.equal(await choices.count(), 3);
  assert.match(await choices.nth(0).innerText(), /1\. Close the sheet \(Recommended\)[\s\S]*Dismiss the rail sheet/);

  // One click answers with that number, naming the question it answers.
  await choices.nth(1).click();
  await card.getByRole('status').getByText('Sent.', { exact: false }).waitFor();
  assert.deepEqual(answers.at(-1), { key: scrimQuestion.key, options: [2] });
  assert.equal(await choices.nth(0).isDisabled(), true, 'the same question cannot be answered twice');

  // The run moves to its next question; the card follows and re-enables.
  prompt = fontQuestion;
  await card.getByText('repo-0p2l.4: which font?').waitFor({ timeout: 10_000 });
  const next = card.getByRole('group', { name: 'Choices' }).getByRole('button');
  await next.first().waitFor();
  assert.equal(await next.first().isEnabled(), true);

  // "Type something" opens a box; its text is sent with the choice.
  await next.nth(1).click();
  await card.getByRole('textbox', { name: 'Your answer' }).fill('Use Petaluma for handwritten scores');
  await card.getByRole('button', { name: 'Send answer' }).click();
  await card.getByRole('status').waitFor();
  assert.deepEqual(answers.at(-1), { key: fontQuestion.key, options: [2], text: 'Use Petaluma for handwritten scores' });

  // A multi-select is ticked, not clicked, and sent as one set. What the run
  // already has ticked is where the boxes start.
  prompt = fruitQuestion;
  await card.getByText('Which fruits should I buy?').first().waitFor({ timeout: 10_000 });
  const boxes = card.getByRole('group', { name: 'Choices' }).getByRole('checkbox');
  assert.equal(await boxes.count(), 3, 'a box per choice, with Type something left a button');
  assert.equal(await boxes.nth(0).isChecked(), true, "the run's own tick carries over");
  assert.equal(await boxes.nth(2).isChecked(), false);
  await boxes.nth(0).uncheck();
  await boxes.nth(2).check();
  await card.getByText('1 ticked', { exact: false }).waitFor();
  await card.getByRole('button', { name: 'Send answers' }).click();
  await card.getByRole('status').getByText('Sent.', { exact: false }).waitFor();
  assert.deepEqual(answers.at(-1), { key: fruitQuestion.key, options: [3] });

  // If the run moved on first, the refusal is explained rather than swallowed.
  prompt = { ...scrimQuestion, key: '3333333333333333' };
  answerStatus = 409;
  const third = card.getByRole('group', { name: 'Choices' }).getByRole('button');
  await card.getByText('Which fix?', { exact: false }).first().waitFor({ timeout: 10_000 });
  await third.first().waitFor();
  await third.first().click();
  await page.getByText('question changed since this page loaded', { exact: false }).waitFor();

  // A screen with no numbered choices (say, a prompt Scotty cannot parse) is shown as-is.
  prompt = null;
  await card.getByText('can’t read any choices', { exact: false }).waitFor({ timeout: 10_000 });
  await card.getByText('rm -rf build', { exact: false }).waitFor();
  assert.deepEqual(errors, [], 'no page errors');
  await page.close();

  // Read Only Mode: the question is readable, answering is off.
  prompt = scrimQuestion;
  const readOnly = await open(false);
  const roCard = readOnly.getByRole('region', { name: 'Goal run ab12cd34 is asking' });
  await roCard.getByText('Read Only Mode is on', { exact: false }).waitFor();
  const roChoices = roCard.getByRole('group', { name: 'Choices' }).getByRole('button');
  assert.equal(await roChoices.first().isDisabled(), true, 'read-only cannot answer');

  console.log('test-goal-answer: passed');
} finally {
  await browser.close();
}
