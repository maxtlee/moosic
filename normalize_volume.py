#!/usr/bin/env python3
"""Per-song loudness normalisation for the Moosic library.

Measures each downloaded MP3 with ffmpeg's EBU R128 loudness filter and stores
a playback gain (dB) in ``$MOOSIC_DATA/gains.json``. The web player applies the
gain in a Web Audio node, so the files themselves are never rewritten and
manual overrides are preserved (re-running without ``--force`` only fills
songs that have no gain yet).

    normalize_volume.py                     # dry-run: report missing gains
    normalize_volume.py --execute           # measure + write missing gains
    normalize_volume.py --execute --force   # re-measure everything
    normalize_volume.py --only yt:abc,yt:def --execute --force

Target is -14 LUFS (a common streaming target), with true-peak-aware clamps so
a boost can never be absurd.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import musiclib as ml  # noqa: E402

TARGET_LUFS = -14.0
MIN_GAIN_DB = -20.0
MAX_GAIN_DB = 12.0
_FILTER = "loudnorm=I={target}:TP=-1.5:LRA=11:print_format=json"
_INPUT_I = re.compile(r'"input_i"\s*:\s*"(-?\d+(?:\.\d+)?|-inf)"')
_INPUT_TP = re.compile(r'"input_tp"\s*:\s*"(-?\d+(?:\.\d+)?|-inf)"')


def measure_lufs(path: Path, start: float = 0.0,
                 seconds: float | None = 45.0) -> tuple[float, float | None] | None:
    """``(integrated LUFS, true peak dBTP)`` for one file, or None.

    By default only a 45-second window from the middle is measured: decoding a
    full track is the expensive part and a mid-song sample tracks the overall
    level closely enough for per-song trim. ``seconds=None`` measures the whole
    file.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    seek: list[str] = []
    if start > 0:
        seek = ["-ss", f"{start:.1f}"]
    limit: list[str] = ["-t", f"{seconds:.1f}"] if seconds else []
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-nostats", *seek, *limit, "-i", str(path),
             "-af", _FILTER.format(target=TARGET_LUFS), "-f", "null", "-"],
            capture_output=True, text=True, timeout=300,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    output = (proc.stderr or "") + (proc.stdout or "")
    match = _INPUT_I.search(output)
    if not match or match.group(1) == "-inf":
        return None
    try:
        lufs = float(match.group(1))
        tp_match = _INPUT_TP.search(output)
        tp = (float(tp_match.group(1))
              if tp_match and tp_match.group(1) != "-inf" else None)
    except ValueError:
        return None
    return lufs, tp


def gain_for(lufs: float, tp: float | None = None, target: float = TARGET_LUFS,
             min_gain: float = MIN_GAIN_DB, max_gain: float = MAX_GAIN_DB) -> float:
    gain = target - lufs
    if tp is not None:
        # Keep the boosted true peak at or below -1.5 dBTP so quiet tracks can
        # be lifted without clipping.
        gain = min(gain, -1.5 - tp)
    return round(max(min_gain, min(max_gain, gain)), 2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", type=str, default=None,
                        help="comma-separated song ids (or id substrings)")
    parser.add_argument("--force", action="store_true",
                        help="re-measure songs that already have a gain")
    parser.add_argument("--execute", action="store_true",
                        help="write gains.json (default: dry run)")
    parser.add_argument("--limit", type=int, default=0,
                        help="stop after N songs (0 = all)")
    parser.add_argument("--workers", type=int, default=4,
                        help="parallel ffmpeg measurements (default 4)")
    parser.add_argument("--target", type=float, default=TARGET_LUFS,
                        help=f"target integrated loudness in LUFS (default {TARGET_LUFS})")
    parser.add_argument("--sample-seconds", type=float, default=45.0,
                        help="measure this many seconds from the middle (0 = whole file)")
    args = parser.parse_args()

    songs = ml.load_master().get("songs", [])
    if args.only:
        wanted = {x.strip() for x in args.only.split(",") if x.strip()}
        songs = [s for s in songs
                 if s.get("id") in wanted or any(w in (s.get("id") or "") for w in wanted)]
    gains = ml.load_gains()
    todo = [s for s in songs
            if ml.asset_file(s).is_file() and (args.force or s.get("id") not in gains)]
    if args.limit:
        todo = todo[: args.limit]

    print(f"songs={len(songs)}  to_measure={len(todo)}  existing_gains={len(gains)}")
    if not args.execute:
        for s in todo[:20]:
            print(f"   measure  {s.get('artist')} — {s.get('title')}")
        if len(todo) > 20:
            print(f"   … and {len(todo) - 20} more")
        print("DRY RUN — re-run with --execute to measure and write gains.")
        return 0
    if not todo:
        print("nothing to do")
        return 0

    measured = failed = 0
    new_gains: dict[str, float] = {}
    window = args.sample_seconds if args.sample_seconds > 0 else None
    def measure(song: dict) -> tuple[float, float | None] | None:
        duration = song.get("duration") or 0
        start = max(0.0, (duration - window) / 2) if window and duration else 0.0
        return measure_lufs(ml.asset_file(song), start, window)

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(measure, s): s for s in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            song = futures[fut]
            result = fut.result()
            if result is None:
                failed += 1
            else:
                lufs, tp = result
                new_gains[song["id"]] = gain_for(lufs, tp, target=args.target)
                measured += 1
            if i % 25 == 0 or i == len(futures):
                print(f"   {i}/{len(futures)} measured={measured} failed={failed}", flush=True)

    # Merge instead of clobbering: a manual edit or an auto re-measure made
    # while this batch was running must survive.
    with ml.flock():
        merged = ml.load_gains()
        merged.update(new_gains)
        ml.save_gains(merged)
    print(f"measured={measured}  failed={failed}  wrote={ml.GAINS}", flush=True)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
