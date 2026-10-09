# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the standalone Moosic server.

Build from this directory:  pyinstaller --noconfirm --clean moosic.spec
Output: dist/moosic (or dist/moosic.exe on Windows).
"""

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = collect_submodules("uvicorn") + ["app", "musiclib"]

a = Analysis(
    ["moosic_server.py"],
    pathex=["..", "../.."],          # web/, and the repo root (musiclib.py)
    binaries=[],
    datas=[("../static", "static")],  # ship the SPA assets
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="moosic",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
)
