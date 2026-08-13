import hashlib
import io
import json
import secrets
from datetime import datetime

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from . import ai, db, gcode
from pathlib import Path

from .config import DATA_DIR, DEFAULT_PRINTER, GCODE_DIR, PRINTS_DIR, STATIC_DIR

app = FastAPI(title="Hyrel Print Assistant")

db.init()


def _seed_default_printer() -> None:
    with db.connect() as conn:
        row = conn.execute("SELECT id FROM printers LIMIT 1").fetchone()
        if row is None:
            conn.execute("INSERT INTO printers (name) VALUES (?)", (DEFAULT_PRINTER,))


_seed_default_printer()


def print_dir(print_id: str):
    d = PRINTS_DIR / print_id
    (d / "photos").mkdir(parents=True, exist_ok=True)
    return d


def get_print(print_id: str) -> dict:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM prints WHERE id = ?", (print_id,)).fetchone()
    p = db.row_to_dict(row)
    if p is None:
        raise HTTPException(404, "print not found")
    return p


def write_meta(print_id: str) -> None:
    """Mirror the DB record into meta.json so the folder is self-contained
    (the folder tree, not the sqlite file, is the durable dataset)."""
    p = get_print(print_id)
    with db.connect() as conn:
        photos = [dict(r) for r in conn.execute(
            "SELECT filename, caption, source, created_at FROM photos WHERE print_id = ?",
            (print_id,))]
        printer = conn.execute(
            "SELECT name, make, model FROM printers WHERE id = ?", (p["printer_id"],)).fetchone()
    p["photos"] = photos
    p["printer"] = dict(printer) if printer else None
    (print_dir(print_id) / "meta.json").write_text(json.dumps(p, indent=2))


# ---------- printers ----------

@app.get("/api/printers")
def list_printers():
    with db.connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM printers ORDER BY name")]


@app.post("/api/printers")
def create_printer(name: str = Form(...), make: str = Form(""), model: str = Form("")):
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO printers (name, make, model) VALUES (?, ?, ?)", (name, make, model))
        return {"id": cur.lastrowid, "name": name}


# ---------- prints ----------

@app.get("/api/prints")
def list_prints():
    with db.connect() as conn:
        rows = conn.execute("""
            SELECT p.*, pr.name AS printer_name,
                   (SELECT COUNT(*) FROM photos WHERE print_id = p.id) AS photo_count
            FROM prints p LEFT JOIN printers pr ON pr.id = p.printer_id
            ORDER BY p.created_at DESC
        """)
        return [db.row_to_dict(r) for r in rows]


@app.get("/api/gcode-files")
def list_gcode_files():
    """List sliced gcode in Repetrel's project folder so students can pick a
    file directly instead of hunting through an OS file dialog."""
    if GCODE_DIR is None or not GCODE_DIR.exists():
        return {"available": False, "root": None, "files": []}
    found = []
    for pattern in ("*.gcode", "*.gc", "*.nc"):
        found.extend(GCODE_DIR.rglob(pattern))
    found.sort(key=lambda f: f.stat().st_mtime, reverse=True)
    return {
        "available": True,
        "root": str(GCODE_DIR),
        "files": [
            {"path": str(f.relative_to(GCODE_DIR)),
             "mtime": datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="minutes"),
             "size": f.stat().st_size}
            for f in found[:100]
        ],
    }


def _resolve_source(source_path: str) -> Path:
    if GCODE_DIR is None:
        raise HTTPException(400, "GCODE_DIR is not configured")
    p = (GCODE_DIR / source_path).resolve()
    if not p.is_relative_to(GCODE_DIR) or not p.is_file():
        raise HTTPException(400, "bad source path")
    return p


@app.post("/api/prints")
async def create_print(
    gcode_file: UploadFile | None = File(None),
    source_path: str = Form(""),
    printer_id: int = Form(...),
    operator: str = Form(""),
    feedstock_batch: str = Form(""),
    solids_loading_pct: float | None = Form(None),
    nozzle_diameter_mm: float | None = Form(None),
    notes: str = Form(""),
):
    src = None
    if source_path:
        src = _resolve_source(source_path)
        raw = src.read_bytes()
        filename = src.name
    elif gcode_file is not None and gcode_file.filename:
        raw = await gcode_file.read()
        filename = gcode_file.filename
    else:
        raise HTTPException(400, "provide a gcode file or a source_path")

    text = raw.decode("utf-8", errors="replace")
    sha = hashlib.sha256(raw).hexdigest()

    print_id = f"{datetime.now():%Y%m%d}-{secrets.token_hex(3)}"
    d = print_dir(print_id)
    (d / filename).write_bytes(raw)

    params = gcode.analyze(text)
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO prints (id, printer_id, created_at, operator, gcode_filename,
                   gcode_sha256, gcode_source_path, params_json, feedstock_batch,
                   solids_loading_pct, nozzle_diameter_mm, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (print_id, printer_id, db.utcnow(), operator, filename, sha,
             str(src) if src else "", json.dumps(params), feedstock_batch,
             solids_loading_pct, nozzle_diameter_mm, notes),
        )
    write_meta(print_id)
    return get_print(print_id)


@app.get("/api/prints/{print_id}")
def print_detail(print_id: str):
    p = get_print(print_id)
    with db.connect() as conn:
        p["photos"] = [dict(r) for r in conn.execute(
            "SELECT * FROM photos WHERE print_id = ? ORDER BY id", (print_id,))]
        p["chat"] = [dict(r) for r in conn.execute(
            "SELECT role, content, created_at FROM chat_messages WHERE print_id = ? ORDER BY id",
            (print_id,))]
    return p


# "tuning" = print completed but parameters are being refined (over-extrusion,
# solids-loading effects, speed/flow balance, ...) — not a failure.
OUTCOMES = ("success", "tuning", "partial", "failure", "unknown")

# Observation vocabulary doubles as the dataset's label set — keep it stable.
OBSERVATION_TAGS = (
    "over-extrusion", "under-extrusion", "slumping", "drying-cracks",
    "poor-layer-bonding", "stringing", "clogging", "priming-issue",
    "warping-detachment", "collapse", "surface-quality", "dimensional-error",
)


@app.post("/api/prints/{print_id}/outcome")
def set_outcome(print_id: str, outcome: str = Form(...), outcome_notes: str = Form(""),
                tags: str = Form("")):
    if outcome not in OUTCOMES:
        raise HTTPException(400, "bad outcome")
    get_print(print_id)
    clean_tags = ",".join(t for t in (s.strip() for s in tags.split(",")) if t)
    with db.connect() as conn:
        conn.execute("UPDATE prints SET outcome = ?, outcome_notes = ?, tags = ? WHERE id = ?",
                     (outcome, outcome_notes, clean_tags, print_id))
    write_meta(print_id)
    return {"ok": True}


@app.get("/api/tags")
def list_tags():
    return {"outcomes": OUTCOMES, "tags": OBSERVATION_TAGS}


# ---------- settings: model + API key ----------

def _mask_key(key: str) -> str:
    return key[:11] + "…" + key[-4:] if len(key) > 20 else "…"


@app.get("/api/settings")
def get_settings():
    import os
    ui_key = db.get_setting("api_key")
    env_key = os.environ.get("ANTHROPIC_API_KEY")
    active = ui_key or env_key
    return {
        "key_source": "ui" if ui_key else ("env" if env_key else "none"),
        "key_hint": _mask_key(active) if active else None,
    }


@app.post("/api/settings/key")
def set_api_key(api_key: str = Form("")):
    api_key = api_key.strip()
    if not api_key:  # clear the UI key, fall back to .env
        db.delete_setting("api_key")
        return get_settings()
    try:
        ai.verify_key(api_key)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    db.set_setting("api_key", api_key)
    return get_settings()

@app.get("/api/models")
def list_models():
    return {"models": ai.MODELS,
            "current": db.get_setting("model", ai.DEFAULT_MODEL)}


@app.post("/api/models")
def set_model(model: str = Form(...)):
    if model not in ai.MODEL_IDS:
        raise HTTPException(400, "unknown model")
    db.set_setting("model", model)
    return {"current": model}


@app.post("/api/prints/{print_id}/notes")
def set_notes(print_id: str, notes: str = Form("")):
    get_print(print_id)
    with db.connect() as conn:
        conn.execute("UPDATE prints SET notes = ? WHERE id = ?", (notes, print_id))
    write_meta(print_id)
    return {"ok": True}


@app.post("/api/prints/{print_id}/fields")
async def set_custom_fields(print_id: str, fields_json: str = Form(...)):
    """Replace the print's custom key/value fields (free-form dataset columns
    the lab can add without code changes)."""
    get_print(print_id)
    try:
        fields = json.loads(fields_json)
        assert isinstance(fields, dict)
    except (json.JSONDecodeError, AssertionError):
        raise HTTPException(400, "fields_json must be a JSON object")
    fields = {str(k)[:80]: str(v)[:2000] for k, v in fields.items() if str(k).strip()}
    with db.connect() as conn:
        conn.execute("UPDATE prints SET custom_json = ? WHERE id = ?",
                     (json.dumps(fields), print_id))
    write_meta(print_id)
    return {"custom": fields}


@app.get("/api/prints/{print_id}/gcode")
def download_gcode(print_id: str):
    p = get_print(print_id)
    path = PRINTS_DIR / print_id / p["gcode_filename"]
    if not path.exists():
        raise HTTPException(404, "gcode file missing")
    return FileResponse(path, filename=p["gcode_filename"])


@app.post("/api/prints/{print_id}/revisions")
def save_revision(print_id: str, content: str = Form(...)):
    """Save an AI-proposed gcode edit as a numbered revision file — in the
    print's data folder, and (when the print came from Repetrel's folder)
    next to the original so it's one File > Open away in Repetrel. The
    original file is never touched."""
    p = get_print(print_id)
    d = print_dir(print_id)
    n = 1 + sum(1 for f in d.glob("revision_*.gcode"))
    path = d / f"revision_{n:02d}.gcode"
    path.write_text(content)

    repetrel_path = None
    src = p.get("gcode_source_path")
    if src and GCODE_DIR is not None:
        sp = Path(src)
        if sp.is_relative_to(GCODE_DIR) and sp.parent.is_dir():
            target = sp.parent / f"{sp.stem}_rev{n:02d}.gcode"
            target.write_text(content)
            repetrel_path = str(target)

    return {"filename": path.name, "repetrel_path": repetrel_path}


# ---------- photos ----------

MAX_PHOTO_EDGE = 2000  # px — plenty for diagnosis, keeps API image tokens sane


@app.post("/api/prints/{print_id}/photos")
async def upload_photo(print_id: str, file: UploadFile = File(...), caption: str = Form(""),
                       source: str = Form("upload")):
    get_print(print_id)
    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw))
        img = img.convert("RGB")
        img.thumbnail((MAX_PHOTO_EDGE, MAX_PHOTO_EDGE))
    except Exception:
        raise HTTPException(415, "Unsupported image format — use JPEG/PNG (iPhones: set "
                                 "camera format to 'Most Compatible' or share as JPEG)")
    with db.connect() as conn:
        n = conn.execute("SELECT COUNT(*) FROM photos WHERE print_id = ?",
                         (print_id,)).fetchone()[0]
        filename = f"photo_{n + 1:02d}.jpg"
        img.save(print_dir(print_id) / "photos" / filename, "JPEG", quality=90)
        conn.execute(
            "INSERT INTO photos (print_id, filename, caption, source, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (print_id, filename, caption, source[:120], db.utcnow()))
    write_meta(print_id)
    return {"filename": filename}


@app.get("/api/prints/{print_id}/photos/{filename}")
def get_photo(print_id: str, filename: str):
    path = print_dir(print_id) / "photos" / filename
    if ".." in filename or not path.exists():
        raise HTTPException(404)
    return FileResponse(path)


# ---------- chat ----------

def build_lab_context(print_id: str, tags: str) -> str:
    """The 'learning over time' layer: curated lab lessons + similar past
    cases pulled from the app's own records. The model stays frozen; the
    context it sees grows with every print the lab logs."""
    parts = []

    lessons = DATA_DIR / "LESSONS.md"
    if lessons.exists():
        parts.append("Curated lab lessons (maintained by the lab):\n"
                     + lessons.read_text()[:8000])

    with db.connect() as conn:
        rows = [db.row_to_dict(r) for r in conn.execute(
            """SELECT * FROM prints
               WHERE id != ? AND (outcome != 'unknown' OR outcome_notes != '')
               ORDER BY created_at DESC LIMIT 40""", (print_id,))]

    wanted = set(t for t in tags.split(",") if t)
    rows.sort(key=lambda p: len(wanted & set((p.get("tags") or "").split(","))),
              reverse=True)
    cases = []
    for p in rows[:5]:
        flow = (p["params"].get("flow_settings_m221") or [{}])[:1]
        cases.append(
            f"- {p['id']} ({p['created_at'][:10]}): outcome={p['outcome']}, "
            f"tags=[{p.get('tags', '')}], solids%={p['solids_loading_pct']}, "
            f"feed={p['params'].get('feed_rate_min')}-{p['params'].get('feed_rate_max')}, "
            f"M221={flow[0] if flow else {}}, notes: {p['outcome_notes'] or p['notes']}")
    if cases:
        parts.append("Similar past prints in this lab (use them — cite the "
                     "print IDs when relevant):\n" + "\n".join(cases))

    return "\n\n".join(parts)


@app.post("/api/prints/{print_id}/chat")
def chat(print_id: str, message: str = Form(...), include_photos: bool = Form(True)):
    p = get_print(print_id)
    with db.connect() as conn:
        printer = conn.execute("SELECT name FROM printers WHERE id = ?",
                               (p["printer_id"],)).fetchone()
        history = [dict(r) for r in conn.execute(
            "SELECT role, content FROM chat_messages WHERE print_id = ? ORDER BY id",
            (print_id,))]
        photos = [dict(r) for r in conn.execute(
            "SELECT filename FROM photos WHERE print_id = ? ORDER BY id", (print_id,))]

    gcode_path = PRINTS_DIR / print_id / p["gcode_filename"]
    gcode_text = gcode_path.read_text(errors="replace") if gcode_path.exists() else ""
    ctx = ai.build_print_context(
        p, printer["name"] if printer else "?",
        gcode.context_snippet(gcode_text, p["params"]) if gcode_text else "(no gcode on file)")

    images = []
    if include_photos:
        for ph in photos:
            path = print_dir(print_id) / "photos" / ph["filename"]
            if path.exists():
                images.append((path.read_bytes(), "image/jpeg"))

    lab_ctx = build_lab_context(print_id, p.get("tags", "") or "")
    model = db.get_setting("model", ai.DEFAULT_MODEL)
    api_key = db.get_setting("api_key")
    try:
        reply = ai.chat(ctx, history, message, images, lab_context=lab_ctx,
                        model=model, api_key=api_key)
    except RuntimeError as e:  # e.g. missing API key — explain, don't 500
        raise HTTPException(503, str(e))

    with db.connect() as conn:
        conn.execute("INSERT INTO chat_messages (print_id, role, content, created_at) "
                     "VALUES (?, 'user', ?, ?)", (print_id, message, db.utcnow()))
        conn.execute("INSERT INTO chat_messages (print_id, role, content, created_at) "
                     "VALUES (?, 'assistant', ?, ?)", (print_id, reply, db.utcnow()))

    # Chat transcript also lives in the print folder for dataset portability.
    log = print_dir(print_id) / "chat.md"
    with log.open("a") as f:
        f.write(f"\n## user ({db.utcnow()})\n{message}\n\n## assistant\n{reply}\n")

    return {"reply": reply}


# Photos come from the PC itself: "Capture from camera" (any UVC webcam or USB
# microscope, and a Canon via EOS Webcam Utility) or "Import files" off the
# card. There is deliberately no phone-upload path — it was the only reason to
# listen on the LAN, and nothing here is authenticated, so the app now binds to
# localhost only (see HOST in config.py).

app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
