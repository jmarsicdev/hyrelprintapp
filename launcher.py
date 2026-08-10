"""Entry point for the packaged HyrelAssistant.exe: starts the server and
opens the browser. Also works from source: python launcher.py"""

import threading
import webbrowser

import uvicorn

from app.config import HOST, PORT
from app.main import app


def main() -> None:
    threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    print(f"Hyrel Print Assistant running at http://localhost:{PORT}")
    print("Keep this window open while using the app. Ctrl+C to stop.")
    uvicorn.run(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
