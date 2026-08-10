let currentPrint = null;
let knownTags = [];

const $ = (sel) => document.querySelector(sel);

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------- list ----------

async function loadPrints() {
  const prints = await api('/api/prints');
  const tbody = $('#printsTable tbody');
  tbody.innerHTML = '';
  for (const p of prints) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${p.id}</td><td>${p.created_at.slice(0, 10)}</td>` +
      `<td>${p.printer_name ?? ''}</td><td>${p.operator}</td>` +
      `<td class="outcome-${p.outcome}">${p.outcome}</td><td>${p.photo_count}</td>`;
    tr.onclick = () => openPrint(p.id);
    tbody.appendChild(tr);
  }
}

// ---------- detail ----------

async function openPrint(id) {
  const p = await api(`/api/prints/${id}`);
  currentPrint = p;
  $('#printList').classList.add('hidden');
  $('#printDetail').classList.remove('hidden');
  $('#detailTitle').textContent = `Print ${p.id}`;

  const meta = $('#detailMeta');
  const rows = {
    'Created': p.created_at, 'Operator': p.operator || '—',
    'G-code': p.gcode_filename, 'Feedstock batch': p.feedstock_batch || '—',
    'Solids %': p.solids_loading_pct ?? '—', 'Nozzle mm': p.nozzle_diameter_mm ?? '—',
    'Layers (est.)': p.params?.estimated_layer_count ?? '—',
    'Layer height (est.)': p.params?.estimated_layer_height ?? '—',
    'Notes': p.notes || '—',
  };
  meta.innerHTML = Object.entries(rows)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  $('#outcomeSelect').value = p.outcome;
  $('#outcomeNotes').value = p.outcome_notes;
  renderTags(p.tags || '');
  $('#qrImg').src = `/api/prints/${p.id}/qr?t=${Date.now()}`;
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
    row.innerHTML = `<b>${k}</b>: ${v} <button type="button" class="field-del">×</button>`;
    row.querySelector('.field-del').onclick = () => { row.remove(); saveCustomFields(); };
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

function renderChat(messages) {
  const log = $('#chatLog');
  log.innerHTML = '';
  for (const m of messages) {
    const div = document.createElement('div');
    div.className = `msg ${m.role}`;
    div.textContent = m.content;
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
  const hasGcodeBlock = messages.some(
    (m) => m.role === 'assistant' && m.content.includes('```gcode'));
  $('#saveRevision').classList.toggle('hidden', !hasGcodeBlock);
}

// ---------- events ----------

$('#backBtn').onclick = () => {
  $('#printDetail').classList.add('hidden');
  $('#printList').classList.remove('hidden');
  loadPrints();
};

$('#newPrintBtn').onclick = async () => {
  const printers = await api('/api/printers');
  $('#printerSelect').innerHTML = printers
    .map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  $('#newPrintDialog').showModal();
};
$('#cancelNew').onclick = () => $('#newPrintDialog').close();

$('#newPrintForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  for (const k of ['solids_loading_pct', 'nozzle_diameter_mm'])
    if (!fd.get(k)) fd.delete(k);
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
    $('#cameraSelect').innerHTML = devices
      .map((d) => `<option value="${d.deviceId}">${d.label || 'camera'}</option>`).join('');
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
  const mine = document.createElement('div');
  mine.className = 'msg user';
  mine.textContent = text;
  log.appendChild(mine);
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
    wait.classList.remove('pending');
    wait.textContent = r.reply;
    const p = await api(`/api/prints/${currentPrint.id}`);
    renderChat(p.chat);
  } catch (err) {
    wait.textContent = 'Error: ' + err.message;
  } finally {
    $('#chatSend').disabled = false;
  }
};

$('#saveRevision').onclick = async () => {
  const p = await api(`/api/prints/${currentPrint.id}`);
  const lastWithBlock = [...p.chat].reverse()
    .find((m) => m.role === 'assistant' && m.content.includes('```gcode'));
  if (!lastWithBlock) return;
  const match = lastWithBlock.content.match(/```gcode\n([\s\S]*?)```/);
  if (!match) return;
  const fd = new FormData();
  fd.append('content', match[1]);
  const r = await api(`/api/prints/${currentPrint.id}/revisions`, { method: 'POST', body: fd });
  alert(`Saved as ${r.filename} in the print folder.`);
};

loadPrints();
