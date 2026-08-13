// Exercises the chat markdown renderer straight out of static/app.js against a
// minimal DOM, so what is tested is what ships. Run: node test_markdown.js
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2] || 'static/app.js', 'utf8');

// --- tiny DOM: enough for the renderer, and serialisable so we can assert ---
const mkText = (t) => ({ nodeType: 3, text: String(t) });
function mkEl(tag) {
  const el = {
    tag, nodeType: 1, children: [],
    className: '', type: '', href: '', target: '', rel: '',
    appendChild(c) { el.children.push(c); return c; },
    append(...cs) { for (const c of cs) el.children.push(c); },
    replaceWith() {},
    get lastChild() { return el.children[el.children.length - 1]; },
    set textContent(v) { el.children = [mkText(v)]; },
    get textContent() { return text(el); },
    set onclick(f) { el._onclick = f; },
    get onclick() { return el._onclick; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
  return el;
}
function text(node) {
  if (node.nodeType === 3) return node.text;
  return (node.children || []).map(text).join('');
}
function html(node) {
  if (node.nodeType === 3) return node.text;
  const inner = (node.children || []).map(html).join('');
  if (node.tag === '#fragment') return inner;
  return `<${node.tag}>${inner}</${node.tag}>`;
}

const stub = new Proxy({}, {
  get: (t, k) => (k === 'classList' ? { toggle() {}, add() {}, remove() {} }
    : k === 'style' ? {} : typeof k === 'string' ? () => {} : undefined),
  set: () => true,
});
const ctx = {
  document: {
    querySelector: () => stub,
    createElement: mkEl,
    createTextNode: mkText,
    createDocumentFragment: () => mkEl('#fragment'),
  },
  fetch: () => new Promise(() => {}),
  navigator: { mediaDevices: {}, clipboard: { writeText: async () => {} } },
  setTimeout, Uint32Array, Math, JSON, Number, String, Array, Object, Promise,
  FormData: function () {}, console,
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { renderMarkdown, renderMessage } = ctx;

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const render = (md) => html(renderMarkdown(md));

check('paragraphs split on blank lines, soft breaks join', () => {
  assert.strictEqual(render('one\ntwo\n\nthree'), '<p>one two</p><p>three</p>');
});

check('headings become real heading elements', () => {
  assert.strictEqual(render('## Diagnosis'), '<h4>Diagnosis</h4>');
  assert.strictEqual(render('# Top'), '<h3>Top</h3>');
});

check('bullet and numbered lists render as ul/ol', () => {
  assert.strictEqual(render('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.strictEqual(render('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
});

check('nested bullets nest', () => {
  const out = render('- outer\n  - inner');
  assert.strictEqual(out, '<ul><li>outer<ul><li>inner</li></ul></li></ul>');
});

check('bold, italic and inline code', () => {
  assert.strictEqual(render('set **S** to `1.15` and *retry*'),
    '<p>set <strong>S</strong> to <code>1.15</code> and <em>retry</em></p>');
});

check('fenced code becomes a code block with its language', () => {
  const out = render('```gcode\nM221 S1.1\nG1 X10\n```');
  assert.ok(out.includes('<pre><code>M221 S1.1\nG1 X10</code></pre>'), out);
  assert.ok(out.includes('gcode'), 'language label shown');
});

check('code fence contents are never treated as markdown', () => {
  const out = render('```gcode\n; **not bold** and - not a list\n```');
  assert.ok(out.includes('; **not bold** and - not a list'), out);
  assert.ok(!out.includes('<strong>'), 'no markup inside code');
});

check('a gcode block reports itself to the caller', () => {
  const seen = [];
  renderMarkdown('```gcode\nM221 S1.2\n```', (lang, code) => seen.push([lang, code]));
  assert.deepStrictEqual(seen.map((s) => s[0]), ['gcode']);
  assert.strictEqual(seen[0][1], 'M221 S1.2');
});

check('tables render', () => {
  const out = render('| param | before | after |\n| --- | --- | --- |\n| S | 1.0 | 1.15 |');
  assert.ok(out.includes('<th>param</th>'), out);
  assert.ok(out.includes('<td>1.15</td>'), out);
});

check('blockquotes and rules render', () => {
  assert.strictEqual(render('> careful'), '<blockquote><p>careful</p></blockquote>');
  assert.ok(render('---').includes('<hr>'));
});

check('http links become anchors', () => {
  const out = render('see [wiki](https://hyrel3d.com/wiki)');
  assert.ok(out.includes('<a>wiki</a>'), out);
});

check('javascript: links stay inert text', () => {
  const out = render('[click](javascript:alert(1))');
  assert.ok(!out.includes('<a>'), 'must not become a link');
  assert.ok(out.includes('[click](javascript:alert(1))'), out);
});

check('HTML in model output is escaped, never markup', () => {
  const md = 'careful <script>alert(1)</script> and <img src=x onerror=y>';
  const node = renderMarkdown(md);
  // Text is preserved verbatim; no <script>/<img> element is ever created.
  assert.ok(text(node).includes('<script>alert(1)</script>'), 'text kept');
  const tags = [];
  (function walk(n) {
    if (n.nodeType === 1 && n.tag !== '#fragment') tags.push(n.tag);
    (n.children || []).forEach(walk);
  })(node);
  assert.ok(!tags.includes('script') && !tags.includes('img'), tags.join(','));
});

check('a user message stays verbatim, unparsed', () => {
  const node = renderMessage('user', 'why is **this** happening?\nline two');
  assert.strictEqual(text(node), 'why is **this** happening?\nline two');
  assert.strictEqual(node.children.length, 1, 'no markdown elements');
});

check('a realistic reply renders end to end', () => {
  const reply = [
    'Your corners are over-extruding.',
    '',
    '## What to change',
    '',
    '1. Drop `M221 S` from 1.0 to **0.9**',
    '2. Slow the perimeter to F900',
    '',
    '```gcode',
    'M221 S0.9 T11 P1760 W0.5 Z0.3',
    'G1 X30 Y10 F900 E0.15',
    '```',
    '',
    'Then reprint and compare layer 3.',
  ].join('\n');
  const blocks = [];
  const out = html(renderMarkdown(reply, (l, c) => blocks.push(l)));
  assert.deepStrictEqual(blocks, ['gcode']);
  assert.ok(out.includes('<h4>What to change</h4>'), out);
  assert.ok(out.includes('<ol>'), 'numbered steps');
  assert.ok(out.includes('<strong>0.9</strong>'), 'bold survives');
  assert.ok(out.includes('M221 S0.9 T11 P1760 W0.5 Z0.3'), 'gcode present');
});

console.log(`\n${pass}/${pass} markdown tests passed`);
