import json
import sqlite3
from datetime import datetime, timezone

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS printers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    make TEXT DEFAULT '',
    model TEXT DEFAULT '',
    notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS prints (
    id TEXT PRIMARY KEY,
    printer_id INTEGER REFERENCES printers(id),
    created_at TEXT NOT NULL,
    operator TEXT DEFAULT '',
    gcode_filename TEXT DEFAULT '',
    gcode_sha256 TEXT DEFAULT '',
    params_json TEXT DEFAULT '{}',
    feedstock_batch TEXT DEFAULT '',
    solids_loading_pct REAL,
    nozzle_diameter_mm REAL,
    notes TEXT DEFAULT '',
    outcome TEXT DEFAULT 'unknown',
    outcome_notes TEXT DEFAULT '',
    tags TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    print_id TEXT NOT NULL REFERENCES prints(id),
    filename TEXT NOT NULL,
    caption TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY,
    print_id TEXT NOT NULL REFERENCES prints(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS specimens (
    id INTEGER PRIMARY KEY,
    print_id TEXT NOT NULL REFERENCES prints(id),
    label TEXT NOT NULL,
    notes TEXT DEFAULT ''
);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    if "params_json" in d:
        d["params"] = json.loads(d.pop("params_json") or "{}")
    return d
