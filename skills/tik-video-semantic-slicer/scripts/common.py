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


def validate_selection(sentences, selection, config, content=None):
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
        count = len(group) if content is None else len(selected_units(sentences, content, group, config["product_id"]))
        # Legacy snapshots used phrase counts; require semantic units for new patches.
        lo, hi = (module["min"], module["max"]) if content is not None else {"hook": (2, 5), "value": (0, None), "close": (2, 3)}[module["key"]]
        if count < lo or (hi is not None and count > hi):
            raise ValueError(f"Module semantic unit count: {module['key']}")
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


def selected_units(sentences, content, indices, product_id):
    """Validate explicit product spans and whole units, without inferring identity."""
    indexed = unique_map(sentences["sentences"], "index")
    products = unique_map(content["products"], "id")
    if product_id not in products:
        raise ValueError("Unknown product_id")
    owners = {}
    for pid, product in products.items():
        if not product.get("label") or not str(product.get("evidence", "")).strip() or not product["spans"]:
            raise ValueError("Product needs label, spans and identity evidence")
        for first, last in product["spans"]:
            if type(first) is not int or type(last) is not int or first > last:
                raise ValueError("Product spans use inclusive stable integer indices")
            rows = [indexed.get(i) for i in range(first, last + 1)]
            if not all(rows) or len({s["source_id"] for s in rows}) != 1:
                raise ValueError("Product span must stay within one source")
            for s in rows:
                i = s["index"]
                if i in owners:
                    raise ValueError(f"Overlapping product spans at {i}")
                owners[i] = pid
    units, seen = [], set()
    for unit in content["units"]:
        if not unit or any(type(i) is not int or i not in indexed for i in unit):
            raise ValueError("Semantic unit needs valid integer indices")
        if unit != sorted(set(unit)) or seen.intersection(unit):
            raise ValueError("Semantic units must be ordered and disjoint")
        if len({indexed[i]["source_id"] for i in unit}) != 1 or None in {owners.get(i) for i in unit} or len({owners[i] for i in unit}) != 1:
            raise ValueError("Semantic unit crosses a source/product or has unknown ownership")
        seen.update(unit)
        if set(unit).intersection(indices):
            if not set(unit).issubset(indices):
                raise ValueError(f"Partial semantic unit selected: {unit}")
            if owners[unit[0]] != product_id:
                raise ValueError(f"Cross-product selection: {unit}")
            units.append(unit)
    units.sort(key=lambda u: indices.index(u[0]))
    if [i for unit in units for i in unit] != indices:
        raise ValueError("Selected indices must be covered by whole ordered semantic units")
    return units


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
