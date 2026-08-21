let currentPrint = null;
let knownTags = [];
let modelInfo = [];

const RECORD_FIELDS = ['operator', 'feedstock_batch', 'solids_loading_pct',
  'nozzle_diameter_mm', 'spiral_spacing_mm', 'print_speed', 'pressure_setting',
  'notes'];
// What the record form held when it was last loaded or saved, so we can send
// only the fields this person actually edited.
let loadedRecord = {};

function snapshotRecord() {
  const form = document.querySelector('#recordForm');
  const snap = {};
  for (const name of RECORD_FIELDS) {
    const el = form && form.elements[name];
    if (el) snap[name] = el.value;
  }
  return snap;
}

const $ = (sel) => document.querySelector(sel);

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------- list ----------

function cell(tr, text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text ?? '';
  tr.appendChild(td);
  return td;
}

async function loadPrints() {
  const prints = await api('/api/prints');
  const tbody = $('#printsTable tbody');
  tbody.innerHTML = '';
  for (const p of prints) {
    const tr = document.createElement('tr');
    cell(tr, p.id);
    cell(tr, p.created_at.slice(0, 10));
    cell(tr, p.printer_name ?? '');
    cell(tr, p.operator);
    cell(tr, p.outcome, `outcome-${p.outcome}`);
    cell(tr, p.photo_count);
    tr.onclick = () => openPrint(p.id);
    tbody.appendChild(tr);
  }
  renderPrintNotes(prints);
}

// ---------- notes column ----------

function renderPrintNotes(prints) {
  const box = $('#printNotesList');
  box.innerHTML = '';
  const withNotes = prints.filter((p) => (p.notes || '').trim() || (p.outcome_notes || '').trim());
  if (!withNotes.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No print notes yet. Notes you write on a print show up here.';
    box.appendChild(empty);
    return;
  }
  for (const p of withNotes) {
    const card = document.createElement('div');
    card.className = 'note-card';
    const head = document.createElement('div');
    head.className = 'note-head';
    const who = document.createElement('span');
    who.textContent = `${p.id}${p.operator ? ' · ' + p.operator : ''}`;
    const when = document.createElement('span');
    when.textContent = p.created_at.slice(0, 10);
    head.append(who, when);
    card.appendChild(head);
    if ((p.notes || '').trim()) {
      const body = document.createElement('div');
      body.className = 'note-body';
      body.textContent = p.notes;
      card.appendChild(body);
    }
    if ((p.outcome_notes || '').trim()) {
      const oc = document.createElement('div');
      oc.className = 'note-outcome';
      const label = document.createElement('strong');
      label.textContent = `${p.outcome}: `;
      oc.append(label, document.createTextNode(p.outcome_notes));
      card.appendChild(oc);
    }
    card.onclick = () => openPrint(p.id);
    box.appendChild(card);
  }
}

async function loadLabNotes() {
  try {
    const r = await api('/api/lab-notes');
    $('#labNotes').value = r.text || '';
  } catch { /* leave empty */ }
}

$('#saveLabNotes').onclick = async () => {
  const fd = new FormData();
  fd.append('text', $('#labNotes').value);
  try {
    await api('/api/lab-notes', { method: 'POST', body: fd });
    $('#labNotesStatus').textContent = 'Saved — the AI sees this on every print.';
  } catch (err) {
    $('#labNotesStatus').textContent = 'Error: ' + err.message;
  }
  setTimeout(() => { $('#labNotesStatus').textContent = ''; }, 4000);
};

// ---------- detail ----------

async function openPrint(id) {
  const p = await api(`/api/prints/${id}`);
  currentPrint = p;
  $('#homeGrid').classList.add('hidden');
  $('#printDetail').classList.remove('hidden');
  $('#detailTitle').textContent = `Print ${p.id}`;

  // Read-only facts: what the file and the parser say. Everything the student
  // types lives in the editable record form below.
  const meta = $('#detailMeta');
  meta.innerHTML = '';
  const rows = {
    'Created': p.created_at,
    'G-code': p.gcode_filename,
    'From': p.gcode_source_path || 'uploaded',
    'Layers (est.)': p.params?.estimated_layer_count ?? '—',
    'Layer height (est.)': p.params?.estimated_layer_height ?? '—',
    'Feed range': p.params?.feed_rate_min != null
      ? `${p.params.feed_rate_min} – ${p.params.feed_rate_max}` : '—',
  };
  for (const [k, v] of Object.entries(rows)) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    meta.append(dt, dd);
  }

  const form = $('#recordForm');
  for (const name of RECORD_FIELDS) {
    const el = form.elements[name];
    if (el) el.value = p[name] ?? '';
  }
  loadedRecord = snapshotRecord();

  $('#outcomeSelect').value = p.outcome;
  $('#outcomeNotes').value = p.outcome_notes;
  renderTags(p.tags || '');
  renderPhotos(p.photos);
  renderCustomFields(p.custom || {});
  renderChat(p.chat);
}

function renderCustomFields(custom) {
  const box = $('#customFields');
  box.innerHTML = '';
  for (const [k, v] of Object.entries(custom)) {
    const row = document.createElement('div');
    row.className = 'field-row';
    row.dataset.key = k;
    row.dataset.val = v;
    // Built as nodes, not markup: these values come back from the server and
    // a name like <img src=x onerror=...> would otherwise execute.
    const label = document.createElement('b');
    label.textContent = k;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'field-del';
    del.textContent = '×';
    del.onclick = () => { row.remove(); saveCustomFields(); };
    row.append(label, document.createTextNode(`: ${v} `), del);
    box.appendChild(row);
  }
}

async function saveCustomFields() {
  const fields = {};
  for (const row of document.querySelectorAll('.field-row'))
    fields[row.dataset.key] = row.dataset.val;
  const fd = new FormData();
  fd.append('fields_json', JSON.stringify(fields));
  const r = await api(`/api/prints/${currentPrint.id}/fields`, { method: 'POST', body: fd });
  renderCustomFields(r.custom);
}

function renderPhotos(photos) {
  const strip = $('#photoStrip');
  strip.innerHTML = '';
  for (const ph of photos) {
    const img = document.createElement('img');
    img.src = `/api/prints/${currentPrint.id}/photos/${ph.filename}`;
    img.title = [ph.source, ph.caption].filter(Boolean).join(' — ');
    strip.appendChild(img);
  }
}

function gcodeBlocks(text) {
  const blocks = [];
  const re = /```gcode\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
}

// ---------- markdown rendering ----------
// Small on purpose: the app ships offline as a single exe, so no library.
// Everything goes through textContent — model output is never parsed as HTML.

// ---------- math ----------
// A LaTeX subset, rendered with spans and CSS. Enough for the algebra this
// lab actually writes (flow = W x H x speed x P x S, ratios, exponents,
// Greek); anything it cannot parse is shown as the original source rather
// than silently mangled.

const MATH_GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const MATH_SYMBOLS = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤',
  ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', propto: '∝',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', leftrightarrow: '↔',
  infty: '∞', partial: '∂', sum: '∑', prod: '∏', int: '∫', nabla: '∇',
  ldots: '…', dots: '…', cdots: '⋯', deg: '°', circ: '∘', ll: '≪', gg: '≫',
  sim: '∼', simeq: '≃', perp: '⊥', angle: '∠', in: '∈', pi_: 'π',
};
const MATH_FUNCS = ['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'max', 'min',
  'lim', 'det', 'dim', 'arg'];
const MATH_SPACES = { ',': ' ', ':': ' ', ';': ' ', '!': '', ' ': ' ', quad: ' ', qquad: ' ' };

function mathTokens(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+|[\s\S])/.exec(src.slice(i));
      if (!m) { i++; continue; }
      out.push({ t: 'cmd', v: m[1] });
      i += m[0].length;
    } else if (ch === '{' || ch === '}' || ch === '^' || ch === '_') {
      out.push({ t: ch }); i++;
    } else if (/\s/.test(ch)) {
      out.push({ t: 'ws' }); i++;
    } else {
      out.push({ t: 'ch', v: ch }); i++;
    }
  }
  return out;
}

// Operators and relations get breathing room on both sides, the way real
// notation is set — otherwise "W x H" renders as the unreadable "Wx H".
const MATH_OPERATORS = new Set([
  '×', '·', '÷', '±', '∓', '≤', '≥', '≠', '≈', '≡', '∝', '→', '←', '⇒', '↔',
  '∼', '≃', '≪', '≫', '=', '+', '<', '>', '−',
]);

function mathAtom(ch) {
  if (!MATH_OPERATORS.has(ch)) return document.createTextNode(ch);
  const s = document.createElement('span');
  s.className = 'mbin';
  s.textContent = ch;
  return s;
}

function mathSpan(cls, child) {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  if (child !== undefined) {
    s.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return s;
}

function mathOperand(toks, i) {
  while (toks[i] && toks[i].t === 'ws') i++;
  if (!toks[i]) return { node: document.createDocumentFragment(), next: i };
  if (toks[i].t === '{') return mathSeq(toks, i + 1, true);
  const one = mathSeq([toks[i]], 0, false);
  return { node: one.node, next: i + 1 };
}

function mathCommand(toks, i) {
  const name = toks[i].v;
  i++;
  if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
    const a = mathOperand(toks, i);
    const b = mathOperand(toks, a.next);
    const box = mathSpan('mfrac');
    box.append(mathSpan('mnum', a.node), mathSpan('mden', b.node));
    return { node: box, next: b.next };
  }
  if (name === 'sqrt') {
    let index = null, j = i;
    while (toks[j] && toks[j].t === 'ws') j++;
    if (toks[j] && toks[j].t === 'ch' && toks[j].v === '[') {
      const buf = [];
      j++;
      while (toks[j] && !(toks[j].t === 'ch' && toks[j].v === ']')) { buf.push(toks[j]); j++; }
      j++;
      index = mathSeq(buf, 0, false).node;
    }
    const a = mathOperand(toks, j);
    const box = mathSpan('msqrt');
    if (index) box.appendChild(mathSpan('mroot', index));
    box.append(mathSpan('mradical', '√'), mathSpan('munder', a.node));
    return { node: box, next: a.next };
  }
  if (name === 'text' || name === 'mathrm' || name === 'mathbf' || name === 'mathit'
      || name === 'operatorname') {
    const a = mathOperand(toks, i);
    const cls = name === 'mathbf' ? 'mupright mbold'
      : name === 'mathit' ? 'mitalic' : 'mupright';
    return { node: mathSpan(cls, a.node), next: a.next };
  }
  if (name === 'left' || name === 'right' || name === 'big' || name === 'bigl' || name === 'bigr') {
    let j = i;
    while (toks[j] && toks[j].t === 'ws') j++;
    if (toks[j] && toks[j].t === 'ch') {
      const c = toks[j].v;
      return { node: document.createTextNode(c === '.' ? '' : c), next: j + 1 };
    }
    return { node: document.createDocumentFragment(), next: i };
  }
  if (Object.prototype.hasOwnProperty.call(MATH_SPACES, name)) {
    return { node: document.createTextNode(MATH_SPACES[name]), next: i };
  }
  if (MATH_GREEK[name]) return { node: document.createTextNode(MATH_GREEK[name]), next: i };
  if (MATH_SYMBOLS[name]) return { node: mathAtom(MATH_SYMBOLS[name]), next: i };
  if (MATH_FUNCS.includes(name)) return { node: mathSpan('mupright', name), next: i };
  if (/^[%&_${}#]$/.test(name)) return { node: document.createTextNode(name), next: i };
  // Unknown command: keep it visible as source rather than dropping it.
  return { node: mathSpan('munknown', '\\' + name), next: i };
}

function mathSeq(toks, i, untilBrace) {
  const frag = document.createDocumentFragment();
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.t === '}') {
      if (untilBrace) return { node: frag, next: i + 1 };
      i++; continue;
    }
    let atom;
    if (tk.t === 'ws') { frag.appendChild(document.createTextNode(' ')); i++; continue; }
    if (tk.t === '{') { const g = mathSeq(toks, i + 1, true); atom = mathSpan(null, g.node); i = g.next; }
    else if (tk.t === 'cmd') { const r = mathCommand(toks, i); atom = r.node; i = r.next; }
    else if (tk.t === '^' || tk.t === '_') { atom = mathSpan(null); }
    else {
      const v = tk.v;
      atom = /[A-Za-z]/.test(v) ? mathSpan('mvar', v) : mathAtom(v);
      i++;
    }
    // Attach any trailing sub/superscripts to the atom just produced.
    while (toks[i] && (toks[i].t === '^' || toks[i].t === '_')) {
      const kind = toks[i].t === '^' ? 'sup' : 'sub';
      const r = mathOperand(toks, i + 1);
      const holder = mathSpan('mscripted');
      holder.appendChild(atom);
      const sc = document.createElement(kind);
      sc.appendChild(r.node);
      holder.appendChild(sc);
      atom = holder;
      i = r.next;
    }
    frag.appendChild(atom);
  }
  return { node: frag, next: i };
}

function renderMath(src, display) {
  const wrap = document.createElement(display ? 'div' : 'span');
  wrap.className = display ? 'math-display' : 'math-inline';
  try {
    wrap.appendChild(mathSeq(mathTokens(src), 0, false).node);
  } catch {
    wrap.className = 'math-raw';
    wrap.textContent = src;
  }
  return wrap;
}

// $$..$$ and \[..\] are unambiguous. A single $..$ is ambiguous with prices,
// so it must look like maths: no whitespace hugging the delimiters, short,
// and containing either a LaTeX marker or a letter. That accepts $v$,
// $W = 0.5$ and $F = 900$ while leaving "costs $5 to $10 per part" alone,
// because its content ("5 to ") ends in a space.
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;

function looksLikeMath(s) {
  if (/^\s|\s$/.test(s)) return false;
  if (s.length > 200) return false;
  return /[\\^_]/.test(s) || /[A-Za-z]/.test(s);
}

// A non-global clone of MATH_RE. This function is re-entrant — onText renders
// emphasis, which comes back through here — and a shared /g regex has a
// mutable lastIndex, so a nested call would reset the outer loop and it would
// never terminate on input as ordinary as "the *flow* is $Q = WHv$". Driving a
// non-global regex with an explicit offset keeps that state local without
// recompiling the pattern on every (hot, recursive) call.
const MATH_RE_LOCAL = new RegExp(MATH_RE.source);

function splitMath(text, onText, onMath) {
  let last = 0, pos = 0, m;
  while ((m = MATH_RE_LOCAL.exec(text.slice(pos))) !== null) {
    const index = pos + m.index;
    pos = index + m[0].length;
    const inline1 = m[4];
    if (inline1 !== undefined && !looksLikeMath(inline1)) continue;
    if (index > last) onText(text.slice(last, index));
    const display = m[1] !== undefined || m[2] !== undefined;
    onMath(m[1] ?? m[2] ?? m[3] ?? m[4], display);
    last = pos;
  }
  if (last < text.length) onText(text.slice(last));
}

function mdInline(text, parent) {
  splitMath(text, (chunk) => mdInlineNoMath(chunk, parent),
    (src, display) => parent.appendChild(renderMath(src, display)));
}

// The model sometimes drops a bare \Delta or \approx into prose rather than
// into $..$. Map the ones we know to their symbol so the text reads properly;
// anything unknown is left exactly as written.
function symbolise(s) {
  return s.replace(/\\([A-Za-z]+)/g, (whole, name) =>
    MATH_GREEK[name] || MATH_SYMBOLS[name] || whole);
}

function addText(parent, s) {
  parent.appendChild(document.createTextNode(symbolise(s)));
}

function mdInlineNoMath(text, parent) {
  const re = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|\*([^*\n]+?)\*|~~([\s\S]+?)~~|\[([^\]]+?)\]\(([^)\s]+?)\)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) addText(parent, text.slice(last, m.index));
    if (m[2] !== undefined) {
      const c = document.createElement('code');
      c.className = 'md-code-inline';
      c.textContent = m[2].trim();
      parent.appendChild(c);
    } else if (m[3] !== undefined) {
      const b = document.createElement('strong'); mdInline(m[3], b); parent.appendChild(b);
    } else if (m[4] !== undefined) {
      const i = document.createElement('em'); mdInline(m[4], i); parent.appendChild(i);
    } else if (m[5] !== undefined) {
      const s = document.createElement('s'); mdInline(m[5], s); parent.appendChild(s);
    } else if (m[6] !== undefined) {
      // Only ordinary web links become anchors; anything else stays literal.
      if (/^(https?:|mailto:)/i.test(m[7])) {
        const a = document.createElement('a');
        a.href = m[7]; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = m[6];
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(m[0]));
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) addText(parent, text.slice(last));
}

function mdCodeBlock(lang, code, onCodeBlock) {
  const wrap = document.createElement('div');
  wrap.className = 'codeblock';
  const bar = document.createElement('div');
  bar.className = 'codebar';
  const label = document.createElement('span');
  label.className = 'codelang';
  label.textContent = lang || 'text';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'codecopy';
  copy.textContent = 'Copy';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    } catch { copy.textContent = 'Copy failed'; }
  };
  bar.append(label, copy);
  const pre = document.createElement('pre');
  const c = document.createElement('code');
  c.textContent = code;
  pre.appendChild(c);
  wrap.append(bar, pre);
  if (onCodeBlock) onCodeBlock(lang, code, bar);
  return wrap;
}

function mdList(lines, start, onCodeBlock) {
  const head = lines[start].match(/^(\s*)(?:[-*+]|\d+[.)])\s+/);
  const baseIndent = head[1].length;
  const list = document.createElement(/^\s*\d+[.)]\s/.test(lines[start]) ? 'ol' : 'ul');
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!m) {
      // A wrapped continuation line belongs to the item above it.
      if (lines[i].trim() && lines[i].search(/\S/) > baseIndent && list.lastChild) {
        list.lastChild.appendChild(document.createTextNode(' '));
        mdInline(lines[i].trim(), list.lastChild);
        i++; continue;
      }
      break;
    }
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      const sub = mdList(lines, i, onCodeBlock);
      (list.lastChild || list).appendChild(sub.node);
      i = sub.next; continue;
    }
    const li = document.createElement('li');
    mdInline(m[2], li);
    list.appendChild(li);
    i++;
  }
  return { node: list, next: i };
}

function mdTable(lines, start) {
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
  const table = document.createElement('table');
  table.className = 'md-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const c of cells(lines[start])) {
    const th = document.createElement('th'); mdInline(c, th); hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    const tr = document.createElement('tr');
    for (const c of cells(lines[i])) {
      const td = document.createElement('td'); mdInline(c, td); tr.appendChild(td);
    }
    tbody.appendChild(tr);
    i++;
  }
  table.appendChild(tbody);
  return { node: table, next: i };
}

function renderMarkdown(text, onCodeBlock, depth) {
  const frag = document.createDocumentFragment();
  depth = depth || 0;
  // Nested blockquotes recurse; a pathological ">>>>>…" would otherwise blow
  // the stack and leave the chat pane blank.
  if (depth > 12) {
    frag.appendChild(document.createTextNode(String(text ?? '')));
    return frag;
  }
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const para = [];
  const flush = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    mdInline(para.join(' '), p);
    frag.appendChild(p);
    para.length = 0;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([A-Za-z0-9_+-]*)\s*$/);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      frag.appendChild(mdCodeBlock(fence[1], body.join('\n'), onCodeBlock));
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      const el = document.createElement(`h${Math.min(h[1].length + 2, 6)}`);
      el.className = 'md-h';
      mdInline(h[2], el);
      frag.appendChild(el);
      i++; continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush(); frag.appendChild(document.createElement('hr')); i++; continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const bq = document.createElement('blockquote');
      bq.appendChild(renderMarkdown(buf.join('\n'), onCodeBlock, depth + 1));
      frag.appendChild(bq);
      continue;
    }
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) {
      flush();
      const l = mdList(lines, i, onCodeBlock);
      frag.appendChild(l.node); i = l.next; continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length
        && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const t = mdTable(lines, i);
      frag.appendChild(t.node); i = t.next; continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return frag;
}

function renderMessage(role, content) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'user') {
    // Keep the student's own words verbatim, including line breaks.
    div.textContent = content;
    return div;
  }
  let n = 0;
  const total = gcodeBlocks(content).length;
  div.appendChild(renderMarkdown(content, (lang, code, bar) => {
    if (lang.toLowerCase() !== 'gcode') return;
    n++;
    // The review button lives on the block itself, so what you approve is
    // unambiguously the code you are looking at.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'review-rev';
    btn.textContent = total > 1 ? `Review block ${n} of ${total}…` : 'Review & save…';
    const captured = code;
    btn.onclick = () => openRevisionReview(captured);
    bar.appendChild(btn);
  }));
  return div;
}

function renderChat(messages) {
  const log = $('#chatLog');
  log.innerHTML = '';
  for (const m of messages) log.appendChild(renderMessage(m.role, m.content));
  log.scrollTop = log.scrollHeight;
}

// ---------- events ----------

$('#backBtn').onclick = () => {
  $('#printDetail').classList.add('hidden');
  $('#homeGrid').classList.remove('hidden');
  loadPrints();
};

$('#newPrintBtn').onclick = async () => {
  // new Option(...) sets text, never markup — a gcode filename in the
  // Repetrel folder is not something we should be parsing as HTML.
  const printers = await api('/api/printers');
  const psel = $('#printerSelect');
  psel.innerHTML = '';
  for (const p of printers) psel.add(new Option(p.name, p.id));
  try {
    const g = await api('/api/gcode-files');
    if (g.available && g.files.length) {
      const gsel = $('#serverGcode');
      gsel.innerHTML = '';
      gsel.add(new Option('— upload a file below instead —', ''));
      for (const f of g.files) gsel.add(new Option(`${f.path} (${f.mtime})`, f.path));
      $('#serverGcodeRow').classList.remove('hidden');
    }
  } catch { /* folder not configured — upload only */ }
  $('#newPrintDialog').showModal();
};
$('#cancelNew').onclick = () => $('#newPrintDialog').close();

$('#newPrintForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  for (const k of ['solids_loading_pct', 'nozzle_diameter_mm'])
    if (!fd.get(k)) fd.delete(k);
  const serverPath = $('#serverGcode').value;
  if (serverPath) {
    fd.delete('gcode_file');
    fd.append('source_path', serverPath);
  } else if (!fd.get('gcode_file')?.name) {
    alert('Pick a G-code file (from the printer folder or by upload).');
    return;
  }
  const p = await api('/api/prints', { method: 'POST', body: fd });
  $('#newPrintDialog').close();
  e.target.reset();
  openPrint(p.id);
};

async function renderTags(selected) {
  if (!knownTags.length) knownTags = (await api('/api/tags')).tags;
  const active = new Set(selected.split(',').filter(Boolean));
  const box = $('#tagChips');
  box.innerHTML = '';
  for (const t of knownTags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (active.has(t) ? ' on' : '');
    chip.textContent = t;
    chip.onclick = () => chip.classList.toggle('on');
    box.appendChild(chip);
  }
}

$('#saveOutcome').onclick = async () => {
  const fd = new FormData();
  fd.append('outcome', $('#outcomeSelect').value);
  fd.append('outcome_notes', $('#outcomeNotes').value);
  fd.append('tags', [...document.querySelectorAll('.chip.on')]
    .map((c) => c.textContent).join(','));
  await api(`/api/prints/${currentPrint.id}/outcome`, { method: 'POST', body: fd });
  $('#saveOutcome').textContent = 'Saved ✓';
  setTimeout(() => ($('#saveOutcome').textContent = 'Save'), 1500);
};

$('#photoForm').onsubmit = async (e) => {
  e.preventDefault();
  const files = $('#photoFile').files;
  if (!files.length) return;
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('source', 'import');
    await api(`/api/prints/${currentPrint.id}/photos`, { method: 'POST', body: fd });
  }
  openPrint(currentPrint.id);
};

$('#addField').onclick = async () => {
  const k = $('#newFieldKey').value.trim();
  const v = $('#newFieldVal').value.trim();
  if (!k) return;
  const box = $('#customFields');
  const row = document.createElement('div');
  row.className = 'field-row';
  row.dataset.key = k;
  row.dataset.val = v;
  box.appendChild(row);
  $('#newFieldKey').value = '';
  $('#newFieldVal').value = '';
  await saveCustomFields();
};

// ---------- camera capture (webcam / USB microscope / Canon-as-webcam) ----------

let cameraStream = null;

async function startCamera(deviceId) {
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1920 } }
                    : { width: { ideal: 1920 } },
  });
  $('#cameraPreview').srcObject = cameraStream;
}

$('#captureBtn').onclick = async () => {
  $('#captureStatus').textContent = '';
  $('#captureDialog').showModal();
  try {
    await startCamera(null); // permission prompt first, so labels are visible
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'videoinput');
    const csel = $('#cameraSelect');
    csel.innerHTML = '';
    for (const d of devices) csel.add(new Option(d.label || 'camera', d.deviceId));
  } catch (err) {
    $('#captureStatus').textContent =
      'No camera access: ' + err.message + ' (is the device plugged in?)';
  }
};

$('#cameraSelect').onchange = (e) => startCamera(e.target.value);

$('#snapBtn').onclick = async () => {
  const video = $('#cameraPreview');
  if (!video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  const deviceLabel = $('#cameraSelect').selectedOptions[0]?.textContent || 'camera';
  const fd = new FormData();
  fd.append('file', blob, 'capture.jpg');
  fd.append('caption', $('#captureCaption').value);
  fd.append('source', `capture:${deviceLabel}`);
  await api(`/api/prints/${currentPrint.id}/photos`, { method: 'POST', body: fd });
  $('#captureStatus').textContent = 'Captured ✓ (keep capturing or close)';
  const p = await api(`/api/prints/${currentPrint.id}`);
  renderPhotos(p.photos);
};

$('#closeCapture').onclick = () => {
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  $('#captureDialog').close();
};

$('#chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const log = $('#chatLog');
  log.appendChild(renderMessage('user', text));
  const wait = document.createElement('div');
  wait.className = 'msg assistant pending';
  wait.textContent = 'Thinking… (this can take a minute for big files)';
  log.appendChild(wait);
  log.scrollTop = log.scrollHeight;
  $('#chatSend').disabled = true;
  try {
    const fd = new FormData();
    fd.append('message', text);
    fd.append('include_photos', $('#includePhotos').checked);
    const r = await api(`/api/prints/${currentPrint.id}/chat`, { method: 'POST', body: fd });
    wait.replaceWith(renderMessage('assistant', r.reply));
    const p = await api(`/api/prints/${currentPrint.id}`);
    renderChat(p.chat);
  } catch (err) {
    wait.textContent = 'Error: ' + err.message;
  } finally {
    $('#chatSend').disabled = false;
  }
};

// ---------- revision review ----------

let pendingRevision = null;
let pendingOriginal = '';
let showWholeFile = false;

const DIFF_CONTEXT = 3;
// Cap on the LCS table we are willing to fill. Common prefix/suffix are
// stripped first, so a typical "changed a few header values" edit stays far
// under this even on a very large file.
const DIFF_CELL_BUDGET = 400000;

function lcsOps(a, b) {
  const n = a.length, m = b.length, w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

// Longest increasing subsequence over the second element, so anchor pairs are
// used in a consistent order rather than crossing over each other.
function lisBySecond(pairs) {
  if (!pairs.length) return [];
  const tails = [], tailIdx = [], prev = new Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < j) lo = mid + 1; else hi = mid;
    }
    tails[lo] = j;
    tailIdx[lo] = k;
    prev[k] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const out = [];
  for (let k = tailIdx[tails.length - 1]; k !== -1; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}

// Lines occurring exactly once on both sides within the range: reliable
// alignment points. G-code is full of them (coordinates make most moves
// unique), which is what keeps big files tractable.
function anchorPairs(a, b, lo1, hi1, lo2, hi2) {
  const ca = new Map(), cb = new Map();
  for (let i = lo1; i < hi1; i++) ca.set(a[i], (ca.get(a[i]) || 0) + 1);
  for (let j = lo2; j < hi2; j++) cb.set(b[j], (cb.get(b[j]) || 0) + 1);
  const posB = new Map();
  for (let j = lo2; j < hi2; j++) if (cb.get(b[j]) === 1) posB.set(b[j], j);
  const pairs = [];
  for (let i = lo1; i < hi1; i++) {
    if (ca.get(a[i]) === 1 && posB.has(a[i])) pairs.push([i, posB.get(a[i])]);
  }
  return lisBySecond(pairs);
}

function diffRange(a, b, lo1, hi1, lo2, hi2, out, state) {
  while (lo1 < hi1 && lo2 < hi2 && a[lo1] === b[lo2]) { out.push([' ', a[lo1]]); lo1++; lo2++; }
  const tail = [];
  while (hi1 > lo1 && hi2 > lo2 && a[hi1 - 1] === b[hi2 - 1]) {
    tail.push([' ', a[hi1 - 1]]); hi1--; hi2--;
  }
  tail.reverse();

  const n = hi1 - lo1, m = hi2 - lo2;
  if (n === 0 || m === 0) {
    for (let i = lo1; i < hi1; i++) out.push(['-', a[i]]);
    for (let j = lo2; j < hi2; j++) out.push(['+', b[j]]);
  } else if (n * m <= DIFF_CELL_BUDGET) {
    for (const op of lcsOps(a.slice(lo1, hi1), b.slice(lo2, hi2))) out.push(op);
  } else {
    const anchors = anchorPairs(a, b, lo1, hi1, lo2, hi2);
    if (!anchors.length) {
      // Nothing shared to align on — report it as a wholesale replacement.
      state.coarse = true;
      for (let i = lo1; i < hi1; i++) out.push(['-', a[i]]);
      for (let j = lo2; j < hi2; j++) out.push(['+', b[j]]);
    } else {
      let p1 = lo1, p2 = lo2;
      for (const [i, j] of anchors) {
        diffRange(a, b, p1, i, p2, j, out, state);
        out.push([' ', a[i]]);
        p1 = i + 1; p2 = j + 1;
      }
      diffRange(a, b, p1, hi1, p2, hi2, out, state);
    }
  }
  for (const op of tail) out.push(op);
}

function diffOps(originalText, proposedText) {
  const a = originalText.replace(/\r\n/g, '\n').split('\n');
  const b = proposedText.replace(/\r\n/g, '\n').split('\n');
  const out = [], state = { coarse: false };
  diffRange(a, b, 0, a.length, 0, b.length, out, state);
  return { ops: out, coarse: state.coarse, originalLines: a.length, proposedLines: b.length };
}

function collapseUnchanged(ops) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length <= DIFF_CONTEXT * 2 + 1) out.push(...run);
    else {
      out.push(...run.slice(0, DIFF_CONTEXT));
      out.push(['~', `${run.length - DIFF_CONTEXT * 2} unchanged lines`]);
      out.push(...run.slice(-DIFF_CONTEXT));
    }
    run = [];
  };
  for (const op of ops) {
    if (op[0] === ' ') run.push(op);
    else { flush(); out.push(op); }
  }
  flush();
  return out;
}

function renderRevisionView() {
  const box = $('#revDiff');
  box.innerHTML = '';
  const add = (kind, text, lineNo) => {
    const row = document.createElement('div');
    row.className = `dl dl-${kind === ' ' ? 'ctx' : kind === '+' ? 'add' : kind === '-' ? 'del' : 'skip'}`;
    const num = document.createElement('span');
    num.className = 'dl-num';
    num.textContent = lineNo ?? '';
    const sign = document.createElement('span');
    sign.className = 'dl-sign';
    sign.textContent = kind === '~' ? '' : kind;
    const body = document.createElement('span');
    body.className = 'dl-text';
    body.textContent = kind === '~' ? `⋯ ${text} ⋯` : text;
    row.append(num, sign, body);
    box.appendChild(row);
  };

  if (showWholeFile || !pendingOriginal) {
    pendingRevision.replace(/\r\n/g, '\n').split('\n')
      .forEach((l, i) => add(' ', l, i + 1));
    if (!pendingOriginal) {
      $('#revSummary').textContent =
        'Original unavailable — showing the proposed file in full.';
    }
    return;
  }

  const { ops, coarse, originalLines, proposedLines } = diffOps(pendingOriginal, pendingRevision);
  const added = ops.filter((o) => o[0] === '+').length;
  const removed = ops.filter((o) => o[0] === '-').length;
  $('#revSummary').textContent = (added || removed
    ? `${added} line${added === 1 ? '' : 's'} added, ${removed} removed`
      + (coarse ? ' (changes too large to align line-by-line)' : '')
    : 'No differences from the original file.')
    + ` — proposed ${proposedLines} lines vs original ${originalLines}.`;

  // The AI is allowed to answer with just an edited section. Saving that as a
  // revision would put a truncated file in the Repetrel folder looking every
  // bit as printable as a whole one, so say so plainly before it is written.
  const frag = $('#revFragment');
  const looksPartial = originalLines > 50 && proposedLines < originalLines * 0.6;
  frag.classList.toggle('hidden', !looksPartial);
  if (looksPartial) {
    frag.textContent = `This is only about ${Math.round(proposedLines / originalLines * 100)}%`
      + ` the length of the original — it looks like an excerpt rather than a complete file.`
      + ` Saving it produces a partial G-code file, which is not safe to print as-is.`
      + ` Ask the AI for the complete file if you meant to print this.`;
  }

  let lineNo = 0;
  for (const [kind, text] of collapseUnchanged(ops)) {
    if (kind === ' ' || kind === '+') lineNo++;
    else if (kind === '~') lineNo += Number(text.split(' ')[0]) || 0;
    add(kind, text, kind === '-' || kind === '~' ? null : lineNo);
  }
}

async function openRevisionReview(proposed) {
  pendingRevision = proposed;
  pendingOriginal = '';
  showWholeFile = false;
  $('#revToggle').textContent = 'View whole file';
  $('#revStatus').textContent = '';
  $('#revSave').disabled = false;
  $('#revSummary').textContent = 'Comparing with the original…';
  $('#revDiff').textContent = '';

  const src = currentPrint?.gcode_source_path;
  const dest = $('#revDest');
  if (src) {
    dest.className = 'hint';
    dest.textContent = 'Saves into this print’s data folder and alongside the '
      + 'original, ready to open in Repetrel. The original is never modified.';
  } else {
    dest.className = 'warn';
    dest.textContent = 'This print was created by file upload, so the revision can '
      + 'only be saved inside the app’s data folder — it will not appear next to '
      + 'the original in the Repetrel project folder.';
  }
  $('#revisionDialog').showModal();

  try {
    const r = await fetch(`/api/prints/${currentPrint.id}/gcode`);
    if (r.ok) pendingOriginal = await r.text();
  } catch { /* diff falls back to whole-file view */ }
  renderRevisionView();
}

$('#revToggle').onclick = () => {
  showWholeFile = !showWholeFile;
  $('#revToggle').textContent = showWholeFile ? 'View changes only' : 'View whole file';
  renderRevisionView();
};

$('#revCancel').onclick = () => $('#revisionDialog').close();

$('#revSave').onclick = async () => {
  $('#revSave').disabled = true;
  $('#revStatus').textContent = 'Saving…';
  const fd = new FormData();
  fd.append('content', pendingRevision);
  try {
    const r = await api(`/api/prints/${currentPrint.id}/revisions`,
      { method: 'POST', body: fd });
    $('#revisionDialog').close();
    alert(r.repetrel_path
      ? `Saved as ${r.filename}.\nOpen it in Repetrel: ${r.repetrel_path}\n(The original file was not modified.)`
      : `Saved as ${r.filename} in the print's data folder.\n(No Repetrel copy — this print was created by upload.)`);
  } catch (err) {
    $('#revStatus').textContent = 'Error: ' + err.message;
    $('#revSave').disabled = false;
  }
};

// ---------- model picker ----------

function showModelHint(id) {
  const m = modelInfo.find((x) => x.id === id);
  $('#modelHint').textContent = m ? `${m.price} — ${m.notes}` : '';
}

async function loadModels() {
  const r = await api('/api/models');
  modelInfo = r.models;
  const msel = $('#modelSelect');
  msel.innerHTML = '';
  for (const m of r.models) msel.add(new Option(m.name, m.id));
  msel.value = r.current;
  showModelHint(r.current);
}

$('#modelSelect').onchange = async (e) => {
  const fd = new FormData();
  fd.append('model', e.target.value);
  await api('/api/models', { method: 'POST', body: fd });
  showModelHint(e.target.value);
};

// ---------- API key dialog ----------

async function refreshKeyStatus() {
  const s = await api('/api/settings');
  const label = { ui: `using key pasted here (${s.key_hint})`,
                  env: `using key from .env file (${s.key_hint})`,
                  none: 'no key configured — chat will not work yet' };
  $('#keyStatus').textContent = 'Current: ' + label[s.key_source];
}

$('#keyBtn').onclick = async () => {
  $('#keyResult').textContent = '';
  $('#keyInput').value = '';
  await refreshKeyStatus();
  $('#keyDialog').showModal();
};

$('#keySave').onclick = async () => {
  const key = $('#keyInput').value.trim();
  if (!key) return;
  $('#keyResult').textContent = 'Checking key with Anthropic…';
  try {
    const fd = new FormData();
    fd.append('api_key', key);
    await api('/api/settings/key', { method: 'POST', body: fd });
    $('#keyResult').textContent = 'Key verified and saved ✓';
    $('#keyInput').value = '';
    await refreshKeyStatus();
  } catch (err) {
    $('#keyResult').textContent = err.message.replace(/^.*"detail":"|"}$/g, '');
  }
};

$('#keyUseEnv').onclick = async () => {
  await api('/api/settings/key', { method: 'POST', body: new FormData() });
  $('#keyResult').textContent = 'Reverted to the .env key.';
  await refreshKeyStatus();
};

$('#keyClose').onclick = () => $('#keyDialog').close();

// Shows which build is actually loaded, so a stale browser cache is obvious
// at a glance rather than looking like a failed update.
async function showBuild() {
  try {
    const v = await api('/api/version');
    $('#buildStamp').textContent = v.frozen ? `build ${v.build}` : `dev ${v.build}`;
  } catch { /* older build with no /api/version — leave it blank */ }
}

$('#recordForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!currentPrint) return;
  const status = $('#recordStatus');
  status.textContent = 'Saving…';
  try {
    // Send only what actually changed. The endpoint updates just the keys it
    // receives, so posting the whole form would overwrite a field someone
    // else edited on this print with whatever this page loaded earlier.
    const fd = new FormData();
    let changed = 0;
    for (const name of RECORD_FIELDS) {
      const el = e.target.elements[name];
      if (!el) continue;
      if (el.value !== (loadedRecord[name] ?? '')) { fd.append(name, el.value); changed++; }
    }
    if (!changed) { status.textContent = 'No changes.'; setTimeout(() => { status.textContent = ''; }, 3000); return; }
    const p = await api(`/api/prints/${currentPrint.id}/record`,
      { method: 'POST', body: fd });
    currentPrint = { ...currentPrint, ...p };
    const form = e.target;
    for (const name of RECORD_FIELDS) {
      const el = form.elements[name];
      if (el) el.value = currentPrint[name] ?? '';
    }
    loadedRecord = snapshotRecord();
    status.textContent = 'Saved.';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
  setTimeout(() => { status.textContent = ''; }, 4000);
};

showBuild();
loadLabNotes();
loadModels();
loadPrints();
