// Exercises the revision-diff logic straight out of static/app.js in a stubbed
// DOM, so the algorithm is tested as shipped rather than reimplemented here.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2] || 'static/app.js', 'utf8');

const noop = () => {};
const stubEl = new Proxy({}, {
  get: (t, k) => {
    if (k === 'classList') return { toggle: noop, add: noop, remove: noop };
    if (k === 'style') return {};
    if (k === 'textContent' || k === 'innerHTML' || k === 'className') return '';
    return typeof k === 'string' ? noop : undefined;
  },
  set: () => true,
});
const ctx = {
  document: {
    querySelector: () => stubEl,
    createElement: () => ({ append: noop, appendChild: noop, classList: { add: noop }, style: {} }),
  },
  fetch: () => new Promise(() => {}),
  navigator: { mediaDevices: {} },
  Uint32Array, Math, JSON, Number, String, Array, Object, Promise, FormData: function () {},
  console,
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

const { diffOps, collapseUnchanged, gcodeBlocks } = ctx;
const kinds = (ops) => ops.map((o) => o[0]).join('');
let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

check('identical files produce no +/- lines', () => {
  const t = 'G21\nM221 S1.0\nG1 X10\n';
  const { ops } = diffOps(t, t);
  assert.strictEqual(ops.filter((o) => o[0] !== ' ').length, 0);
});

check('a single changed line shows one - and one +', () => {
  const a = 'G21\nM221 S1.0 P1760\nG1 X10 F1200\n';
  const b = 'G21\nM221 S0.9 P1760\nG1 X10 F1200\n';
  const { ops } = diffOps(a, b);
  const del = ops.filter((o) => o[0] === '-');
  const add = ops.filter((o) => o[0] === '+');
  assert.strictEqual(del.length, 1, 'one removal');
  assert.strictEqual(add.length, 1, 'one addition');
  assert.match(del[0][1], /S1\.0/);
  assert.match(add[0][1], /S0\.9/);
});

check('a pure insertion is not reported as a rewrite', () => {
  const a = 'G21\nG1 X10\n';
  const b = 'G21\nM721 S30 E900\nG1 X10\n';
  const { ops } = diffOps(a, b);
  assert.strictEqual(ops.filter((o) => o[0] === '-').length, 0, 'nothing removed');
  assert.strictEqual(ops.filter((o) => o[0] === '+').length, 1, 'one added');
});

check('a deletion is detected', () => {
  const a = 'G21\nM756 Z0.4\nG1 X10\n';
  const b = 'G21\nG1 X10\n';
  const { ops } = diffOps(a, b);
  assert.strictEqual(ops.filter((o) => o[0] === '-').length, 1);
  assert.strictEqual(ops.filter((o) => o[0] === '+').length, 0);
});

check('edits far apart in a big file are both found, and stay cheap', () => {
  const body = Array.from({ length: 60000 }, (_, i) => `G1 X${i} Y${i} E0.05`);
  const a = ['G21', 'M221 S1.0', ...body, 'M84'].join('\n');
  const b = ['G21', 'M221 S0.8', ...body, 'M30'].join('\n');
  const t0 = Date.now();
  const { ops, coarse } = diffOps(a, b);
  const ms = Date.now() - t0;
  assert.strictEqual(coarse, false, 'prefix/suffix trim keeps it exact');
  assert.strictEqual(ops.filter((o) => o[0] === '-').length, 2);
  assert.strictEqual(ops.filter((o) => o[0] === '+').length, 2);
  assert.ok(ms < 3000, `too slow: ${ms}ms`);
  console.log(`      (60k-line file diffed in ${ms}ms)`);
});

check('a wholesale rewrite falls back to coarse mode instead of hanging', () => {
  const a = Array.from({ length: 1200 }, (_, i) => `G1 X${i}`).join('\n');
  const b = Array.from({ length: 1200 }, (_, i) => `G0 Y${i * 7 + 3}`).join('\n');
  const t0 = Date.now();
  const { coarse } = diffOps(a, b);
  assert.strictEqual(coarse, true, 'over the cell budget -> coarse');
  assert.ok(Date.now() - t0 < 2000);
});

check('long unchanged runs collapse with an accurate count', () => {
  const ops = [
    ...Array.from({ length: 50 }, (_, i) => [' ', `ctx${i}`]),
    ['-', 'old'], ['+', 'new'],
    ...Array.from({ length: 50 }, (_, i) => [' ', `after${i}`]),
  ];
  const out = collapseUnchanged(ops);
  const skips = out.filter((o) => o[0] === '~');
  assert.strictEqual(skips.length, 2, 'one skip marker each side');
  assert.strictEqual(skips[0][1], '44 unchanged lines');
  // 3 context + marker + 3 context, twice, plus the two changed lines
  assert.strictEqual(out.length, 7 + 2 + 7);
  assert.strictEqual(kinds(out.slice(0, 4)), '   ~');
});

check('short unchanged runs are left intact', () => {
  const ops = [[' ', 'a'], [' ', 'b'], ['-', 'x'], [' ', 'c']];
  // compare by value: arrays cross a vm realm boundary, so deepStrictEqual
  // would fail on prototype identity alone
  assert.strictEqual(JSON.stringify(collapseUnchanged(ops)), JSON.stringify(ops));
});

check('every gcode block in a message is found', () => {
  const msg = 'before\n```gcode\nG21\nG1 X1\n```\nmiddle\n```gcode\nG90\n```\nafter';
  const blocks = gcodeBlocks(msg);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0], 'G21\nG1 X1\n');
  assert.strictEqual(blocks[1], 'G90\n');
});

check('prose with no gcode block yields nothing', () => {
  assert.strictEqual(gcodeBlocks('Try lowering M221 S to 0.9 and reprint.').length, 0);
});

check('a header tweak in a big file stays exact and readable', () => {
  // the realistic case: change one flow value near the top of a long file
  const body = Array.from({ length: 40000 }, (_, i) => `G1 X${i % 97}.${i} Y${i}.5 E0.0${i % 9}`);
  const a = ['G21', 'M221 S1.0 T11 P1760 W0.5 Z0.3', ...body].join('\n');
  const b = ['G21', 'M221 S0.85 T11 P1760 W0.5 Z0.3', ...body].join('\n');
  const { ops, coarse } = diffOps(a, b);
  assert.strictEqual(coarse, false);
  assert.strictEqual(ops.filter((o) => o[0] === '-').length, 1);
  assert.strictEqual(ops.filter((o) => o[0] === '+').length, 1);
  const shown = collapseUnchanged(ops);
  assert.ok(shown.length < 40, `review should be short, got ${shown.length} rows`);
});

check('an excerpt is reported as a large deletion, not a rewrite', () => {
  // the AI returning only an edited section rather than the whole file
  const a = Array.from({ length: 5000 }, (_, i) => `G1 X${i} E0.05`).join('\n');
  const b = 'G1 X10 E0.05\nG1 X11 E0.04\nG1 X12 E0.05';
  const { ops, originalLines, proposedLines } = diffOps(a, b);
  assert.strictEqual(originalLines, 5000);
  assert.strictEqual(proposedLines, 3);
  assert.ok(ops.filter((o) => o[0] === '-').length > 4000, 'most of the file is missing');
});

check('CRLF originals do not show every line as changed', () => {
  const a = 'G21\r\nM221 S1.0\r\nG1 X10\r\n';
  const b = 'G21\nM221 S0.9\nG1 X10\n';
  const { ops } = diffOps(a, b);
  assert.strictEqual(ops.filter((o) => o[0] === '-').length, 1, 'only the real change');
});

console.log(`\n${pass}/${pass} diff tests passed`);
