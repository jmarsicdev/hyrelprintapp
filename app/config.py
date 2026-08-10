import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8137"))
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data")).resolve()
DEFAULT_PRINTER = os.environ.get("DEFAULT_PRINTER", "Hyrel")

PRINTS_DIR = DATA_DIR / "prints"
DB_PATH = DATA_DIR / "printlog.sqlite3"

PRINTS_DIR.mkdir(parents=True, exist_ok=True)
