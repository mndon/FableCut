"""Standalone media preparation helpers; Python standard library only."""
import json
import math
from pathlib import Path
import subprocess
import sys


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def number(value, label, minimum=0, maximum=None):
    if isinstance(value, bool):
        raise ValueError(f"{label}: boolean is not a number")
    result = float(value)
    if not math.isfinite(result) or result < minimum or (maximum is not None and result > maximum):
        raise ValueError(f"{label}: out of range ({value})")
    return result


def ffprobe(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams",
                             "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def main_guard(main):
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        print(f"[错误] {error}", file=sys.stderr)
        sys.exit(1)
