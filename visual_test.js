/**
 * Headless visual/smoke harness for the Hyrel Print Assistant UI.
 *
 * Starts its own copy of the app on a scratch port with scratch data dirs,
 * seeds a few prints through the HTTP API, drives the page in headless
 * Chromium and writes full-page screenshots into ./screenshots.
 *
 * It deliberately asserts only on things that survive a redesign: the page
 * loads, the browser reports no console errors or uncaught exceptions, the
 * prints table has rows, and clicking a row reveals #printDetail. No CSS
 * classes, colours or layout details are asserted.
 *
 * Run:  node visual_test.js
 * Exit: 0 = pass, non-zero = fail.
 *
 * Browsers are NOT downloaded by Playwright; it drives the Chrome/Edge that
 * are already installed on this PC (channel 'chrome', then 'msedge', then an
 * explicit executablePath).
 */

'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
// 8137 is the app's own default and may well be a live instance the user is
// looking at — never touch it from a test that wipes its data dirs.
const PORT = 8150;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = './data-visualtest';
const GCODE_DIR = './gcode-visualtest';
const SHOTS = path.join(ROOT, 'screenshots');
const STARTUP_TIMEOUT_MS = 30000;

const PYTHON_CANDIDATES = [
  process.env.VISUAL_TEST_PYTHON,
  // The venv lives at the repo root; this file may run from a worktree
  // three levels below it (.claude/worktrees/<name>).
  path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
  path.join(ROOT, '..', '..', '..', '.venv', 'Scripts', 'python.exe'),
  'C:\\Users\\marsi\\.claude\\jobs\\a236361c\\tmp\\hyrelprintapp\\.venv\\Scripts\\python.exe',
].filter(Boolean);

const BROWSER_LAUNCH_OPTIONS = [
  { channel: 'chrome' },
  { channel: 'msedge' },
  { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
];

const SAMPLE_GCODE = [
  '; visual_test sample job',
  'G21 ; millimetres',
  'G90 ; absolute',
  'M722 S100 E21000 P500 T11',
  'M221 S1.0 T11 P1760 W0.5 Z0.3',
  'G1 Z0.3 F600',
  'G1 X10 Y10 F1200',
  'G1 X40 Y10 E1.2',
  'G1 X40 Y40 E1.2',
  'G1 Z0.6 F600',
  'G1 X10 Y40 E1.2',
  'M104 S0',
  '',
].join('\n');

const log = (...a) => console.log(...a);
const steps = [];
function step(name) {
  steps.push(name);
  log(`\n--- ${name}`);
}

// ---------- filesystem helpers ----------

function rmScratch() {
  // Only ever removes this harness's own scratch dirs.
  for (const rel of [DATA_DIR, GCODE_DIR]) {
    const abs = path.resolve(ROOT, rel);
    if (!abs.includes('visualtest')) throw new Error(`refusing to remove ${abs}`);
    // sqlite/uvicorn can hold the file for a moment after the process dies.
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(abs, { recursive: true, force: true });
        break;
      } catch (e) {
        if (i === 4) log(`  warn: could not remove ${abs}: ${e.message}`);
        else sleepSync(200);
      }
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- server ----------

function findPython() {
  for (const p of PYTHON_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error(
    `no python interpreter found; tried:\n  ${PYTHON_CANDIDATES.join('\n  ')}\n` +
    'Set VISUAL_TEST_PYTHON to the venv python.exe.');
}

function startServer(python) {
  const child = spawn(
    python,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(PORT)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'test-not-real',
        DATA_DIR,
        GCODE_DIR,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

  const serverLog = [];
  const capture = (buf) => {
    const text = buf.toString();
    serverLog.push(text);
    if (serverLog.length > 200) serverLog.shift();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', (e) => serverLog.push(`spawn error: ${e.message}\n`));
  child.serverLog = serverLog;
  return child;
}

function stopServer(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      // uvicorn under a shell-less spawn is a single process, but /T also
      // reaps any reloader/worker children if that ever changes.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) {
    log(`  warn: could not kill server: ${e.message}`);
  }
}

async function waitForServer(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no attempt made';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `server exited early with code ${child.exitCode}\n${child.serverLog.join('')}`);
    }
    try {
      const r = await fetch(`${BASE}/`, { redirect: 'follow' });
      if (r.status === 200) return;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(300);
  }
  throw new Error(
    `server did not answer 200 on ${BASE}/ within ${timeoutMs}ms (last: ${lastErr})\n` +
    child.serverLog.join(''));
}

// ---------- seeding through the app's own HTTP API ----------

async function post(pathname, form) {
  const r = await fetch(BASE + pathname, { method: 'POST', body: form });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST ${pathname} -> ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function gcodeForm(filename, extra) {
  const fd = new FormData();
  fd.append('gcode_file',
    new Blob([SAMPLE_GCODE], { type: 'text/plain' }), filename);
  fd.append('printer_id', '1');
  for (const [k, v] of Object.entries(extra || {})) fd.append(k, String(v));
  return fd;
}

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return fd;
}

async function seedData() {
  const created = [];

  created.push(await post('/api/prints', gcodeForm('bracket_v3.gcode', {
    operator: 'A. Rivera',
    feedstock_batch: 'B12 2026-08-01',
    solids_loading_pct: 58.5,
    nozzle_diameter_mm: 0.6,
    notes: 'First run after re-drying the feedstock.',
  })));

  created.push(await post('/api/prints', gcodeForm('lattice_cube.gcode', {
    operator: 'J. Okoye',
    feedstock_batch: 'B12 2026-08-01',
    solids_loading_pct: 61,
    nozzle_diameter_mm: 0.4,
  })));

  created.push(await post('/api/prints', gcodeForm('crucible_lid.gcode', {
    operator: 'M. Sato',
    feedstock_batch: 'B13 2026-08-09',
    solids_loading_pct: 55,
    nozzle_diameter_mm: 0.8,
  })));

  await post(`/api/prints/${created[0].id}/outcome`, form({
    outcome: 'tuning',
    outcome_notes: 'Corners over-extruded from layer 4 up; bead width grows on '
      + 'the short walls. Dropping M221 S to 0.92 next run.',
    tags: 'over-extrusion,surface-quality',
  }));

  await post(`/api/prints/${created[1].id}/outcome`, form({
    outcome: 'success',
    outcome_notes: 'Clean walls, no slumping.',
    tags: '',
  }));

  await post(`/api/prints/${created[0].id}/notes`, form({
    notes: 'Feedstock dried 24 h at 60 C. Ambient 41% RH.',
  }));

  await post(`/api/prints/${created[2].id}/notes`, form({
    notes: 'Nozzle swapped to 0.8 mm just before this job.',
  }));

  const listed = await (await fetch(`${BASE}/api/prints`)).json();
  if (!Array.isArray(listed) || listed.length < created.length) {
    throw new Error(`expected >= ${created.length} prints from /api/prints, got ` +
      JSON.stringify(listed).slice(0, 300));
  }
  log(`  seeded ${created.length} prints: ${created.map((p) => p.id).join(', ')}`);
  return created;
}

// ---------- browser ----------

async function launchBrowser() {
  const failures = [];
  for (const opts of BROWSER_LAUNCH_OPTIONS) {
    try {
      const browser = await chromium.launch({ headless: true, ...opts });
      log(`  launched via ${JSON.stringify(opts)} (${browser.version()})`);
      return browser;
    } catch (e) {
      failures.push(`${JSON.stringify(opts)}: ${String(e).split('\n')[0]}`);
    }
  }
  throw new Error(`could not launch any installed browser:\n  ${failures.join('\n  ')}`);
}

// Browser-level noise that is not the app's fault. Kept deliberately tiny.
// The favicon is requested by the browser itself, not by the page, and the
// app serves no icon — the resulting 404 says nothing about the UI. Note the
// URL is only in the message *location*, not in its text.
const IGNORED_CONSOLE = [/favicon\.ico/i];

function watchForErrors(page, problems) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = `${msg.text()}`;
    const where = msg.location() ? msg.location().url || '' : '';
    if (IGNORED_CONSOLE.some((re) => re.test(text) || re.test(where))) return;
    const suffix = where ? ` (${where})` : '';
    if (msg.type() === 'error') problems.push(`console.error: ${text}${suffix}`);
    else log(`  console.warn: ${text}${suffix}`);
  });
  page.on('pageerror', (err) => {
    problems.push(`uncaught exception: ${err.stack || err.message}`);
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (IGNORED_CONSOLE.some((re) => re.test(url))) return;
    problems.push(`request failed: ${url} (${req.failure()?.errorText})`);
  });
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file, fullPage: true });
  const size = fs.statSync(file).size;
  log(`  screenshot ${file} (${(size / 1024).toFixed(1)} KB)`);
  if (size < 10 * 1024) {
    throw new Error(`screenshot ${name} is only ${size} bytes — looks blank`);
  }
  return { file, size };
}

// ---------- main ----------

async function main() {
  const problems = [];
  const shots = [];
  let server = null;
  let browser = null;

  try {
    step('Preparing scratch dirs');
    rmScratch();
    fs.mkdirSync(path.resolve(ROOT, GCODE_DIR, 'jobs'), { recursive: true });
    fs.writeFileSync(path.resolve(ROOT, GCODE_DIR, 'jobs', 'sample_part.gcode'),
      SAMPLE_GCODE, 'utf-8');
    fs.mkdirSync(SHOTS, { recursive: true });
    log(`  scratch data=${DATA_DIR} gcode=${GCODE_DIR}`);

    step('Starting the app');
    const python = findPython();
    log(`  python: ${python}`);
    server = startServer(python);
    await waitForServer(server, STARTUP_TIMEOUT_MS);
    log(`  app is answering on ${BASE}/`);

    step('Seeding data through the HTTP API');
    await seedData();

    step('Launching headless browser');
    browser = await launchBrowser();
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
    });
    const page = await context.newPage();
    watchForErrors(page, problems);

    step('Loading the home screen');
    const resp = await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
    if (!resp || resp.status() !== 200) {
      throw new Error(`GET / returned ${resp ? resp.status() : 'no response'}`);
    }

    const rows = page.locator('#printsTable tbody tr');
    await rows.first().waitFor({ state: 'visible', timeout: 15000 });
    const rowCount = await rows.count();
    log(`  prints table has ${rowCount} row(s)`);
    if (rowCount < 1) throw new Error('prints table rendered no rows');

    shots.push(await shot(page, '01-home.png'));

    step('Opening a print detail screen');
    await rows.first().click();
    const detail = page.locator('#printDetail');
    await detail.waitFor({ state: 'visible', timeout: 15000 });
    if (!(await detail.isVisible())) throw new Error('#printDetail did not become visible');
    log('  #printDetail is visible');

    // Let the detail panel finish its own fetches before capturing.
    await page.waitForLoadState('networkidle');
    await sleep(300);
    shots.push(await shot(page, '02-detail.png'));

    // Chat rendering needs no API key: drive the page's own renderMessage()
    // with a representative reply, so markdown, equations and the gcode block
    // are verified exactly as a real answer would be drawn.
    step('Rendering a representative AI reply (markdown + equations + gcode)');
    const SAMPLE = [
      "Your corners are over-extruding because flow is volumetric here.",
      "",
      "## Why",
      "",
      "The dispensed volume per unit length is",
      "",
      "$$ Q = W \\times H \\times v \\times P \\times S $$",
      "",
      "so raising $v$ without lowering $S$ over-fills the corner where the head",
      "slows down. With $W = 0.5$ mm and $H = 0.3$ mm the bead area is",
      "$A = \\frac{W \\times H}{2} \\approx 0.075$ mm².",
      "",
      "### What to change",
      "",
      "1. Drop `M221 S` from **1.0** to **0.92**",
      "2. Slow the perimeter to $F = 900$ mm/min",
      "3. Re-check layer 3 for \\Delta width",
      "",
      "| param | before | after |",
      "| --- | --- | --- |",
      "| S | 1.0 | 0.92 |",
      "| F | 1200 | 900 |",
      "",
      "```gcode",
      "M221 S0.92 T11 P1760 W0.5 Z0.3",
      "G1 X30 Y10 F900 E0.15",
      "```",
      "",
      "> Check the head dialog too — Repetrel sends those before the file.",
    ].join('\n');
    const chatCheck = await page.evaluate((md) => {
      const log = document.querySelector('#chatLog');
      log.innerHTML = '';
      log.appendChild(window.renderMessage('user', 'why are my corners over-extruding?'));
      log.appendChild(window.renderMessage('assistant', md));
      return {
        fractions: log.querySelectorAll('.mfrac').length,
        displayMath: log.querySelectorAll('.math-display').length,
        inlineMath: log.querySelectorAll('.math-inline').length,
        codeBlocks: log.querySelectorAll('.codeblock').length,
        reviewButtons: log.querySelectorAll('.review-rev').length,
        copyButtons: log.querySelectorAll('.codecopy').length,
        headings: log.querySelectorAll('.md-h').length,
        listItems: log.querySelectorAll('li').length,
        tableCells: log.querySelectorAll('.md-table td').length,
        unparsedMath: log.querySelectorAll('.munknown, .math-raw').length,
        // No raw LaTeX or fence markers should survive into visible text.
        leakedSource: /\$|\\frac|\\times|\\Delta|```/.test(log.textContent),
      };
    }, SAMPLE);
    log('  ' + JSON.stringify(chatCheck));
    const need = {
      fractions: 1, displayMath: 1, inlineMath: 4, codeBlocks: 1,
      reviewButtons: 1, copyButtons: 1, headings: 2, listItems: 3, tableCells: 4,
    };
    for (const [k, min] of Object.entries(need)) {
      if (chatCheck[k] < min) {
        throw new Error(`chat rendering: expected at least ${min} ${k}, got ${chatCheck[k]}`);
      }
    }
    if (chatCheck.leakedSource) throw new Error('raw LaTeX or code fence leaked into the visible text');
    if (chatCheck.unparsedMath) throw new Error(`${chatCheck.unparsedMath} math fragment(s) failed to parse`);
    log('  equations, code block, table and headings all rendered');
    await page.locator('#chatLog').scrollIntoViewIfNeeded();
    await sleep(200);
    const chatShot = await shot(page, '03-chat.png');
    shots.push(chatShot);
    // Tight crop of just the chat pane, so the rendering is easy to eyeball.
    const box = await page.locator('#chatLog').boundingBox();
    if (box) {
      const cropped = path.join(SHOTS, '04-chat-closeup.png');
      await page.screenshot({ path: cropped, clip: box });
      shots.push({ file: cropped, size: fs.statSync(cropped).size });
    }

    step('Checking for browser errors');
    if (problems.length) {
      throw new Error(`${problems.length} browser problem(s):\n  - ` + problems.join('\n  - '));
    }
    log('  no console errors or uncaught exceptions');

    log('\n==================== PASS ====================');
    log(`steps completed: ${steps.length}`);
    for (const s of shots) log(`screenshot: ${s.file} (${(s.size / 1024).toFixed(1)} KB)`);
    return 0;
  } catch (err) {
    log('\n==================== FAIL ====================');
    log(`failed during: ${steps[steps.length - 1] || '(startup)'}`);
    log(String(err.stack || err));
    if (problems.length) {
      log('\nbrowser problems collected:');
      for (const p of problems) log(`  - ${p}`);
    }
    if (server && server.serverLog && server.serverLog.length) {
      log('\nlast server output:');
      log(server.serverLog.join('').split('\n').slice(-25).join('\n'));
    }
    return 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopServer(server);
    // Give the OS a moment to release the sqlite file before deleting.
    await sleep(700);
    rmScratch();
    log('cleaned up scratch dirs and stopped the server');
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
