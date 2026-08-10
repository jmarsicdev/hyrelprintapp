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

## Setup on the Hyrel PC (Windows)

1. Install Python 3.12+ from python.org (**check "Add to PATH"**). If the PC
   is offline, download the full installer elsewhere first. Repetrel is a
   .NET 4.8 app — Python does not conflict with it.
2. Copy this folder anywhere (e.g. `C:\hyrel-assistant`).
3. `py check_network.py` — verifies the lab network allows HTTPS to
   `api.anthropic.com`. If this fails, talk to IT before going further.
4. Copy `.env.example` to `.env` and paste in the Anthropic API key.
5. Double-click `run.bat`. First run installs dependencies; then the app is at
   **http://localhost:8137** (bookmark it in the browser on that PC).

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
folder is self-contained and can be synced to a network share or Drive.
`meta.json` includes parsed G-code parameters — for Hyrel that means the
volumetric-flow settings (`M221` S multiplier / P pulses-per-µL / W / Z),
prime/unprime (`M722`/`M721`) pulse counts, tools used, feed-rate range,
estimated layer count/height, and a likely-paste-job flag.

**Write the print ID on every specimen from that print.** That one habit is
what lets future CSI scans join back to gcode + process parameters — which
two of the project's core research directions (G-code-conditioned defect
detection, solids-loading fingerprinting) depend on.

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
