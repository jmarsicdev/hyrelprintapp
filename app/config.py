import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# When bundled by PyInstaller, code+static live in the unpacked temp dir
# (sys._MEIPASS) but data/.env belong next to the .exe itself.
FROZEN = getattr(sys, "frozen", False)
if FROZEN:
    ROOT = Path(sys.executable).resolve().parent
    STATIC_DIR = Path(sys._MEIPASS) / "static"  # type: ignore[attr-defined]
else:
    ROOT = Path(__file__).resolve().parent.parent
    STATIC_DIR = ROOT / "static"

load_dotenv(ROOT / ".env")

# Localhost only: no endpoint is authenticated, so anyone who could reach this
# port could read every print, rewrite gcode in the Repetrel folder, or spend
# the lab's API credits. Nothing needs LAN access now that photos come from
# cameras attached to this PC. Overriding this exposes the whole API.
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8137"))
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data")).resolve()
DEFAULT_PRINTER = os.environ.get("DEFAULT_PRINTER", "Hyrel")

# Repetrel's project folder — where students' sliced gcode lives. The app
# lists files from here and writes AI revisions back next to the original.
_gcode_dir = os.environ.get(
    "GCODE_DIR", "C:\\RepetrelProjects" if os.name == "nt" else "")
GCODE_DIR = Path(_gcode_dir).resolve() if _gcode_dir else None

PRINTS_DIR = DATA_DIR / "prints"
DB_PATH = DATA_DIR / "printlog.sqlite3"

PRINTS_DIR.mkdir(parents=True, exist_ok=True)
