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

No flash drives: students work on the printer PC directly, and photos come
from a camera attached to that PC.

The app listens on **localhost only** and has no login. That is deliberate:
every endpoint is unauthenticated, so exposing the port would let anyone on
the lab network read every print, write gcode into `C:\RepetrelProjects`, or
spend the lab's API credits. Don't change `HOST` in `.env`.

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

Windows Firewall should not prompt at all — the app binds to localhost. If it
does prompt, "Cancel" is the safe answer; the app still works.

## Setup from source (alternative)

1. Install Python 3.12+ from python.org (**check "Add to PATH"**). Repetrel
   is a .NET 4.8 app — Python does not conflict with it.
2. Copy this folder anywhere, copy `.env.example` to `.env`, add the API key.
3. `py check_network.py`, then double-click `run.bat` — the app is at
   **http://localhost:8137**.

## Getting G-code in and out (no copy-paste)

The app integrates with Repetrel at the file level (Repetrel has no plugin
API, and none is needed):

- **In**: the new-print dialog lists recent `.gcode` files straight from
  `C:\RepetrelProjects` (configurable via `GCODE_DIR` in `.env`) — pick one
  from the list; plain file upload remains as a fallback.
- **Out**: when the AI proposes an edit and you click *Save revision*, the
  file is written **next to the original** as `<name>_rev01.gcode` (and also
  archived in the print's data folder). In Repetrel it's one File > Open
  away, in the folder students already use. **The original file is never
  modified.**
- The AI knows Hyrel's locked-vs-editable rules: it won't touch the
  mandatory header lines (reporting/abort/homing), treats machine-specific
  values (M660, M140) as deliberate hand edits only, and warns when a file
  edit to M721/M722/M221 would be overridden by the Repetrel head dialogs.

## Photos: webcams, USB microscope, Canon

- **USB microscope / any webcam**: click **Capture from camera** on a print —
  a device picker + live preview appears in the browser (works for any UVC
  camera, which covers virtually all USB microscopes; no drivers needed).
- **Canon camera**: two options. Install Canon **EOS Webcam Utility** and the
  Canon appears in the same Capture picker; or shoot normally and use
  **Import files** (multi-select) to pull images off the card/USB.
- Every photo records its **source** (`import`, `capture:<device name>`) —
  imaging modality is part of the dataset.

Reach the app as **http://localhost:8137**, not by IP address. Browsers only
grant camera access to `localhost` (or HTTPS), so **Capture from camera** is
silently unavailable over any other address.

There is no phone-upload path. Adding one back means exposing an
unauthenticated API to the lab network, so it would need real authentication
first — see the note at the top.

### API key recommendation

Create a **dedicated workspace** in the Anthropic Console
(console.anthropic.com) named e.g. `hyrel-lab`, generate the key there, and
set a **monthly spend limit** on the workspace. That isolates lab usage from
any personal/research keys, gives per-workspace usage graphs, and makes the
key revocable without collateral damage. The key lives only in `.env` on the
lab PC (never committed — see `.gitignore`).

The chat uses `claude-opus-5` by default, with prompt caching on the
per-print gcode context (follow-up questions are cheap) and server-side
refusal fallbacks enabled. Both the **model** (with per-model cost/quality
notes) and the **API key** can be changed in the UI: the model picker sits
above the chat, and the **API key** button in the header lets anyone paste a
key from their own account — it's verified with a free API call before
saving, stored only in the local database, and "Use .env key" reverts to the
deployed default.

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

## Open: verify on the printer PC

Nothing below is known-broken — none of it can be settled off the machine.

1. **Revisions only reach the Repetrel folder for folder-sourced prints.**
   `save_revision` writes `<name>_revNN.gcode` next to the original only when
   the record carries a `gcode_source_path` inside `GCODE_DIR`. Create the
   print with the **G-code from printer folder** dropdown and it round-trips;
   create it with the **G-code file** upload box and `repetrel_path` comes
   back `null`, so the revision exists only in `data/prints/<id>/` and has to
   be fetched by hand. Both inputs sit in the same dialog and look equally
   valid, which is the trap — confirmed by test, not yet seen on real
   Repetrel data. Worth deciding whether upload should be de-emphasised, or
   whether an uploaded file should be copied into `GCODE_DIR` so revisions
   land somewhere useful either way. The post-save alert does distinguish the
   two cases, but only after the write.
2. **Is `C:\RepetrelProjects` the real path, and is it writable** by the
   account running the app? The `Hyrel` user is always-admin, so this is
   expected to be fine — just unconfirmed.
3. **Does the file list stay usable** against a real project tree? The picker
   walks `GCODE_DIR` recursively on every call and shows the 100 most recent
   `.gcode`/`.gc`/`.nc` files; that has only been tested on a toy folder.
4. **Do real Repetrel files parse as expected** — `app/gcode.py` was written
   against the wiki and a hand-made sample, so check `meta.json` on a first
   real print for sane M221/M721/M722 values and layer count.

## Development

```
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8137
```
