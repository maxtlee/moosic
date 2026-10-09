#!/usr/bin/env python3
"""Standalone launcher for a packaged Moosic server.

Starts the FastAPI app on 127.0.0.1 and opens it in the browser. Point it at an
existing library with ``MOOSIC_DATA`` (default ``~/Moosic``).

Environment:
    MOOSIC_DATA         library/data dir (default ~/Moosic)
    MOOSIC_HOST/PORT    bind address (default 127.0.0.1:8740)
    MOOSIC_NO_BROWSER=1 don't open a browser
"""

from __future__ import annotations

import os
import sys
import threading
import webbrowser
from pathlib import Path


def _resource_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent.parent  # web/


def main() -> None:
    os.environ.pop("MOOSIC_ROOT_PATH", None)  # standalone: serve at /
    data = os.environ.get("MOOSIC_DATA") or str(Path.home() / "Moosic")
    os.environ["MOOSIC_DATA"] = data
    (Path(data) / "playlists").mkdir(parents=True, exist_ok=True)

    sys.path.insert(0, str(_resource_dir()))

    host = os.environ.get("MOOSIC_HOST", "127.0.0.1")
    port = int(os.environ.get("MOOSIC_PORT", "8740"))
    url = f"http://{host}:{port}/"

    print("Moosic")
    print(f"  data : {data}")
    print(f"  url  : {url}")
    print("  set MOOSIC_DATA to use an existing library · Ctrl+C to quit")
    if os.environ.get("MOOSIC_NO_BROWSER") != "1":
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    import uvicorn
    from app import asgi_app

    try:
        uvicorn.run(asgi_app, host=host, port=port, log_level="info")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
