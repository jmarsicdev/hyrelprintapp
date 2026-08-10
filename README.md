# Hyrel Print Assistant

A small local web app that runs on the Windows PC driving the lab's Hyrel
ceramic paste-extrusion printer. It does two jobs at once:

1. **Student AI assistant** — attach a print's G-code, notes, and photos and
   chat with Claude about what happened and how to refine it (failure triage
   *and* parameter tuning: over/under-extrusion, solids loading, speed/flow
   balance). Proposed G-code edits can be saved as numbered revisions.
2. **Lab-notebook dataset** — every print gets a unique ID and a
   self-contained folder (`data/prints/<id>/`) holding the exact gcode, parsed
   parameters, feedstock metadata, photos, outcome + observation tags, and the
   full chat transcript. Specimens labeled with the print ID can later be
   joined to CSI scans — the provenance layer for the metrology lab's ML work.

No flash drives: students use the printer PC directly, and phones upload
photos over the lab LAN by scanning a QR code.

## Setup on the Hyrel PC — easiest path (single EXE)

The Hyrel PC needs **no Python and no dev tools**:

1. On any Windows machine that *does* have Python (your laptop), run
   `build_exe.bat` in this folder once. It produces
   `dist\HyrelAssistant.exe` (self-contained).
2. Copy `HyrelAssistant.exe` and a filled-in `.env` (copy from
   `.env.example`, paste the API key) into a folder on the Hyrel PC, e.g.
   `C:\hyrel-assistant`.
3. Double-click the exe. A console window stays open (that's the server) and
   the browser opens to the app. Data is stored in `data\` next to the exe.
4. If chat fails, check the network first: the app must reach
   `api.anthropic.com` over HTTPS (run `check_network.py` from source, or
   just try the chat — a missing key or blocked network produces a clear
   error message in the chat window).

Windows Firewall will prompt on first run — choose "Allow" so phones on the
lab network can reach the QR photo-upload page.

## Setup from source (alternative)

1. Install Python 3.12+ from python.org (**check "Add to PATH"**). Repetrel
   is a .NET 4.8 app — Python does not conflict with it.
2. Copy this folder anywhere, copy `.env.example` to `.env`, add the API key.
3. `py check_network.py`, then double-click `run.bat` — the app is at
   **http://localhost:8137**.

## Photos: phones, webcams, USB microscope, Canon

- **Phone**: scan the print's QR code; upload straight from the phone camera.
- **USB microscope / any webcam**: click **Capture from camera** on a print —
  a device picker + live preview appears in the browser (works for any UVC
  camera, which covers virtually all USB microscopes; no drivers needed).
- **Canon camera**: two options. Install Canon **EOS Webcam Utility** and the
  Canon appears in the same Capture picker; or shoot normally and use
  **Import files** (multi-select) to pull images off the card/USB.
- Every photo records its **source** (`phone`, `import`,
  `capture:<device name>`) — imaging modality is part of the dataset.

Phones must be on the same network as the PC for QR photo upload, and Windows
Firewall must allow inbound connections to Python on port 8137 (Windows will
prompt on first run — choose "Allow").

### API key recommendation

Create a **dedicated workspace** in the Anthropic Console
(console.anthropic.com) named e.g. `hyrel-lab`, generate the key there, and
set a **monthly spend limit** on the workspace. That isolates lab usage from
any personal/research keys, gives per-workspace usage graphs, and makes the
key revocable without collateral damage. The key lives only in `.env` on the
lab PC (never committed — see `.gitignore`).

The chat uses `claude-opus-5` with prompt caching on the per-print gcode
context (follow-up questions are cheap) and server-side refusal fallbacks
enabled.

## Where the data lives

```
data/
  printlog.sqlite3          # index DB (rebuildable)
  prints/<print-id>/
    <original>.gcode        # exact file as printed
    revision_01.gcode       # AI-proposed edits the student saved
    meta.json               # full record — the durable, portable dataset unit
    chat.md                 # AI conversation transcript
    photos/photo_01.jpg     # normalized to JPEG, max 2000 px
```

The folder tree (not the sqlite file) is the dataset of record: each print
folder is self-contained and can be synced to a network share or Drive. Set
`DATA_DIR` in `.env` to store it somewhere else (e.g. a synced/network
folder) — the app doesn't care where it lives.

**Changing what gets recorded:** every print supports **custom fields**
(key/value pairs added in the UI — drying time, humidity, kiln schedule,
anything) with no code changes; they're stored in the DB and `meta.json` and
shown to the AI. The fixed form fields live in `app/main.py::create_print`,
the observation-tag vocabulary in `app/main.py::OBSERVATION_TAGS` — both are
one-place edits. Old records are unaffected by additions (the DB migrates
itself; meta.json just gains keys).
`meta.json` includes parsed G-code parameters — for Hyrel that means the
volumetric-flow settings (`M221` S multiplier / P pulses-per-µL / W / Z),
prime/unprime (`M722`/`M721`) pulse counts, tools used, feed-rate range,
estimated layer count/height, and a likely-paste-job flag.

**Write the print ID on every specimen from that print.** That one habit is
what lets future CSI scans join back to gcode + process parameters — which
two of the project's core research directions (G-code-conditioned defect
detection, solids-loading fingerprinting) depend on.

## How it learns over time

The model itself is frozen (no fine-tuning), but the assistant's knowledge
grows with the lab's records — which in practice is what "a model that learns"
looks like at this scale:

- **Similar past cases**: each chat automatically includes summaries of up to
  5 previous prints with overlapping observation tags (their parameters,
  outcomes, and notes), so the AI can say "print 20260810-99e262 had the same
  slumping at 62% solids and slowing the perimeter fixed it."
- **Curated lessons**: keep a `data/LESSONS.md` file with the lab's distilled
  rules of thumb (e.g. "below 60% solids our slurry slumps on >30mm walls").
  If present it is included in every chat. Curate it after interesting
  sessions — deliberate curation beats automatic accumulation.
- **The long game**: once hundreds of tagged photos + parameter records
  accumulate, this dataset can train small dedicated models (photo → defect
  tag, parameters → outcome) — that's the metrology-lab research track, and
  this app's records are its training data.

## Repetrel notes (from Hyrel's wiki — verify on the machine)

- Repetrel installs at `C:\Repetrel`; student work lives in
  `C:\RepetrelProjects` (Hyrel's own "zip this to move work" folder). That's
  where to browse for gcode when creating a print record — a future version
  can watch it automatically.
- `C:\Repetrel\data\G-Code dictionary.csv` documents the dialect — useful for
  extending `app/gcode.py`.
- **Important:** pressing Print sends the *head-dialog* settings
  (prime/unprime/flow values set in the Repetrel UI) before streaming the
  file. The gcode on disk may not contain every parameter actually used — if
  you changed values in the head dialogs, note them in the print record.
- The PC streams gcode line-by-line to the printer over serial; it must stay
  on during prints (this app running alongside is fine — there is no
  plugin/conflict surface).
- Machines ship with an always-admin Windows user named `Hyrel` and require
  English system locale — don't change either.

## Development

```
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8137
```
