"""Local data helpers only; no ASR client or FableCut transport."""
import json
import math
import subprocess
import sys
from pathlib import Path

EPS = 1e-6
MODULES = json.loads((Path(__file__).parent / "modules.json").read_text(encoding="utf-8"))["modules"]
TRANSITIONS = {"none", "fade", "zoom", "iris", "spin", "blur", "whip", "glitch", "pop"}
TRANSITIONS.update(f"{kind}-{direction}" for kind in ("slide", "wipe")
                   for direction in ("left", "right", "up", "down"))


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


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


def unique_map(items, key):
    result = {}
    for item in items:
        ident = item[key]
        if ident in result:
            raise ValueError(f"Duplicate {key}: {ident}")
        result[ident] = item
    return result


def validate_selection(sentences, selection, config):
    indexed = unique_map(sentences["sentences"], "index")
    indices = selection["keep_indices"]
    if selection.get("template") != "内容策略":
        raise ValueError("selection.template must be 内容策略")
    if not indices:
        raise ValueError("No usable selection; do not create/export an empty cut")
    if any(type(i) is not int for i in indices) or len(set(indices)) != len(indices):
        raise ValueError("Selection indices must be unique integers")
    groups = config["groups"]
    ordered = []
    for module in MODULES:
        group = groups[module["key"]]
        if len(group) < module["min"] or (module["max"] is not None and len(group) > module["max"]):
            raise ValueError(f"Module sentence count: {module['key']}")
        ordered.extend(group)
    if ordered != indices:
        raise ValueError("Module concatenation must exactly equal keep_indices, including order")
    for key in ("hook", "value"):
        if groups[key] != sorted(groups[key]):
            raise ValueError(f"{key} must follow source order")
    allowed = config.get("allowed_speakers")
    if not isinstance(allowed, list) or not allowed:
        raise ValueError("allowed_speakers must explicitly list the retained source-scoped speaker IDs")
    selected = []
    for index in indices:
        if index not in indexed:
            raise ValueError(f"Unknown sentence index: {index}")
        sentence = indexed[index]
        if not sentence["eligible"] or sentence["speaker_id"] not in allowed:
            raise ValueError(f"Sentence {index} is outside the requested range/speaker scope")
        start = number(sentence["start"], "sentence.start")
        end = number(sentence["end"], "sentence.end")
        if end <= start:
            raise ValueError(f"Sentence {index} has no positive duration")
        selected.append(sentence)
    return selected


def ffprobe(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams",
                             "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def project_duration(project):
    disabled = project.get("disabledTracks", [])
    return max((number(c["start"], "clip.start") + number(c["duration"], "clip.duration")
                for c in project.get("clips", []) if c["track"] not in disabled), default=0)


def main_guard(main):
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        print(f"[错误] {error}", file=sys.stderr)
        sys.exit(1)
