"""Generate FableCut patch data without executing CLI, HTTP, or a renderer."""
import argparse
import re
from pathlib import Path

from common import (EPS, TRANSITIONS, main_guard, number, read_json, unique_map,
                    validate_selection, write_json)


def refined_parts(sentence, refinements):
    windows = refinements.get(str(sentence["index"]))
    if windows is None:
        return [(sentence["start"], sentence["end"], sentence["text"])]
    words = sentence["words"]
    if not words or not isinstance(windows, list) or not windows:
        raise ValueError("Refinement requires nonempty windows and reliable word timestamps")
    previous, parts = sentence["start"], []
    for window in windows:
        start, end = number(window[0], "refine.start"), number(window[1], "refine.end")
        if len(window) != 2 or start < previous - EPS or start < sentence["start"] - EPS or end > sentence["end"] + EPS or end <= start:
            raise ValueError("Refinement windows must be ordered, disjoint and inside the sentence")
        selected = [w for w in words if w["start"] >= start - EPS and w["end"] <= end + EPS]
        if not selected or abs(selected[0]["start"] - start) > EPS or abs(selected[-1]["end"] - end) > EPS:
            raise ValueError("Refinement cuts must use exact ASR word boundaries")
        parts.append((start, end, "".join(w["word"] + w["punc"] for w in selected)))
        previous = end
    return parts


def check_project_mapping(project, mapping):
    """Compare submitted geometry to a freshly read native project snapshot."""
    actual = unique_map(project["clips"], "id")
    media = unique_map(project["media"], "id")
    for entry in mapping["entries"]:
        expected = entry["clip"]
        clip = actual.get(expected["id"])
        if clip is None:
            raise ValueError(f"Missing submitted clip: {expected['id']}")
        for key in ("kind", "mediaId", "track"):
            if clip.get(key) != expected.get(key):
                raise ValueError(f"Project/mapping mismatch: {clip['id']}.{key}")
        for key in ("start", "in", "duration"):
            if abs(number(clip[key], key) - expected[key]) > 0.001:
                raise ValueError(f"Project/mapping timing mismatch: {clip['id']}.{key}")
        for key, value in expected["props"].items():
            if clip.get("props", {}).get(key) != value:
                raise ValueError(f"Project/mapping property mismatch: {clip['id']}.{key}")
        for key in ("transitionIn", "transitionOut"):
            if (clip.get(key) or None) != (expected.get(key) or None):
                raise ValueError(f"Project/mapping transition mismatch: {clip['id']}.{key}")
        if clip["track"] in project.get("disabledTracks", []):
            raise ValueError(f"Cut track is disabled: {clip['track']}")
        if clip.get("keyframes"):
            raise ValueError("Managed clips have unexpected animation; reconcile before validating")
        if clip["kind"] == "video":
            if media[clip["mediaId"]]["src"] != entry["source_src"]:
                raise ValueError(f"Imported source changed: {clip['mediaId']}")
            duration = number(media[clip["mediaId"]].get("duration", entry["source_duration"]), "media.duration")
            if clip["in"] + clip["duration"] * clip["props"]["speed"] > duration + EPS:
                raise ValueError(f"Source boundary exceeded: {clip['id']}")
    managed = {e["clip"]["id"] for e in mapping["entries"]}
    for clip in project["clips"]:
        if clip["id"] not in managed and clip["track"] not in project.get("disabledTracks", []):
            if clip["track"] == "V1" or clip["start"] + clip["duration"] > mapping["duration"] + EPS:
                raise ValueError("Unrelated clips alter the cut; use a dedicated project or reconcile explicitly")
    for key, value in mapping.get("project_settings", {}).items():
        if project.get(key) != value:
            raise ValueError(f"Project setting mismatch: {key}")
    return actual


def build(sentences, selection, config, sources, project, project_id, previous=None):
    selected = validate_selection(sentences, selection, config)
    speed = number(config["speed"], "speed", 0.25, 4)
    target = number(config["target_duration"], "target_duration", 35, 90)
    namespace = config["namespace"]
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", namespace):
        raise ValueError("namespace must be a lowercase identifier, at most 64 characters")
    source_map = unique_map(sources["sources"], "id")
    media_map = unique_map(project["media"], "id")
    current = unique_map(project["clips"], "id")
    if previous and (previous["project_id"] != project_id or previous["namespace"] != namespace):
        raise ValueError("Previous mapping belongs to another project/run")
    if previous:
        check_project_mapping(project, previous)
    owned = {entry["clip"]["id"] for entry in previous["entries"]} if previous else set()
    refinements = config.get("refinements", {})
    if any(k not in {str(s["index"]) for s in selected} for k in refinements):
        raise ValueError("Refinement references an unselected sentence")
    transition = config.get("transition", {"type": "none"})
    kind = transition["type"]
    if kind not in TRANSITIONS:
        raise ValueError("Unknown FableCut transition")
    overlap = 0 if kind == "none" else number(transition.get("duration", 0.3), "transition.duration", 0.001)
    cursor, entries = 0.0, []
    for sentence in selected:
        source = source_map[sentence["source_id"]]
        media = media_map[source["media_id"]]
        if media["kind"] != "video":
            raise ValueError("Imported source must be video media")
        # The CLI may register only id/kind/src; use measured local metadata, never guessed duration.
        measured = media.get("duration")
        if measured is None:
            measured = read_json(source["probe"])["duration"]
        source_end = number(measured, "media.duration", 0.001)
        for part, (start, end, text) in enumerate(refined_parts(sentence, refinements)):
            if end > source_end + EPS:
                raise ValueError(f"Sentence {sentence['index']} exceeds imported media duration")
            duration = (end - start) / speed
            if entries:
                cursor -= overlap
            clip = {"id": f"{namespace}_s{sentence['index']}_{part}", "kind": "video",
                    "mediaId": media["id"], "track": "V1", "start": cursor,
                    "in": start, "duration": duration, "name": text,
                    "props": {"speed": speed}}
            if overlap and entries:
                clip["transitionIn"] = {"type": kind, "duration": overlap}
            entries.append({"index": sentence["index"], "part": part, "source_id": source["id"],
                            "source_duration": source_end, "source_src": media["src"],
                            "text": text, "clip": clip})
            cursor += duration
    for i, entry in enumerate(entries):
        reserved = overlap * ((i > 0) + (i < len(entries) - 1))
        if entry["clip"]["duration"] <= reserved and overlap:
            raise ValueError("Transition windows consume a short clip; reduce the requested overlap")
    if not 35 - EPS <= cursor <= 90 + EPS:
        raise ValueError(f"Cut duration {cursor:.3f}s outside 35–90s; adjust the selection")
    settings = config.get("project", {})
    if set(settings) - {"name", "width", "height", "fps", "background"}:
        raise ValueError("Unsupported project setting")
    for key in ("width", "height", "fps"):
        number(settings.get(key, project[key]), f"project.{key}", 1)
    subtitles = config.get("subtitles", False)
    if type(subtitles) is not bool:
        raise ValueError("subtitles must be a boolean")
    if subtitles:
        width, height = (settings.get(k, project[k]) for k in ("width", "height"))
        style = {"font": "Noto Sans SC", "fontSize": round(min(width, height) * 0.045, 2),
                 "color": "#ffffff", "align": "center", "y": height * 0.36,
                 "boxW": width * 0.86, "boxH": height * 0.20, "boxFit": True,
                 "bgColor": "#000000", "bgOpacity": 0.65, "textAnim": "none"}
        style.update(config.get("subtitle_style", {}))
        if "text" in style:
            raise ValueError("Use subtitle_text for text corrections")
        corrections = config.get("subtitle_text", {})
        valid_keys = {f"{e['index']}:{e['part']}" for e in entries}
        if set(corrections) - valid_keys:
            raise ValueError("subtitle_text contains a stale sentence/part reference")
        for entry in list(entries):
            video = entry["clip"]
            key = f"{entry['index']}:{entry['part']}"
            text = corrections.get(key, entry["text"])
            if not isinstance(text, str) or not text.strip():
                raise ValueError("Subtitle text cannot be empty")
            subtitle = {"id": f"{namespace}_sub{entry['index']}_{entry['part']}", "kind": "text",
                        "mediaId": None, "track": "V2", "start": video["start"], "in": 0,
                        "duration": video["duration"], "props": {**style, "text": text}}
            entries.append({"index": entry["index"], "part": entry["part"],
                            "source_id": entry["source_id"], "text": text, "clip": subtitle})
        # A transition overlaps pictures, but subtitles switch at the next spoken clip.
        text_entries = [e for e in entries if e["clip"]["kind"] == "text"]
        if overlap:
            for left, right in zip(text_entries, text_entries[1:]):
                left["clip"]["duration"] = right["clip"]["start"] - left["clip"]["start"]
    desired_ids = {e["clip"]["id"] for e in entries}
    if (desired_ids & set(current)) - owned:
        raise ValueError("Generated clip ID already exists but is not owned by this run")
    managed_tracks = {e["clip"]["track"] for e in entries}
    if managed_tracks & set(project.get("disabledTracks", [])):
        raise ValueError("A required cut track is disabled")
    for clip in current.values():
        if clip["id"] not in owned and clip["track"] not in project.get("disabledTracks", []):
            if clip["track"] in managed_tracks or clip["start"] + clip["duration"] > cursor + EPS:
                raise ValueError("Unrelated clips occupy the cut tracks/time range; use a dedicated project")
    ops = [{"op": "removeClip", "id": ident} for ident in sorted(owned - desired_ids)]
    if settings:
        ops.append({"op": "setProject", "set": settings})
    for entry in entries:
        clip = entry["clip"]
        if clip["id"] in current:
            update = {k: v for k, v in clip.items() if k != "id"}
            # Clear our old transition geometry when changing back to hard cuts.
            for key in ("transitionIn", "transitionOut"):
                update.setdefault(key, None)
            ops.append({"op": "updateClip", "id": clip["id"], "set": update})
        else:
            ops.append({"op": "addClip", "clip": clip})
    mapping = {"project_id": project_id, "namespace": namespace, "base_revision": project["revision"],
               "duration": cursor, "target_duration": target, "groups": config["groups"],
               "project_settings": settings, "entries": entries}
    return ops, mapping


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("sentences", "selection", "config", "sources", "project", "project-id", "out"):
        parser.add_argument("--" + arg, required=True)
    parser.add_argument("--previous", help="Only the mapping verified after the last successful patch")
    args = parser.parse_args()
    sentences, selection = read_json(args.sentences), read_json(args.selection)
    ops, mapping = build(sentences, selection, read_json(args.config),
                         read_json(args.sources), read_json(args.project), args.project_id,
                         read_json(args.previous) if args.previous else None)
    out = Path(args.out)
    write_json(out / "ops.json", ops)
    write_json(out / "pending_mapping.json", mapping)
    print(f"[通过] {len(ops)} patch operations; cut {mapping['duration']:.3f}s, target {mapping['target_duration']:g}s")
    selected_indices = set(selection["keep_indices"])
    unusual = [s["index"] for s in sentences["sentences"]
               if s["index"] in selected_indices and not 1 <= s["end"] - s["start"] <= 7]
    if unusual:
        print(f"[提醒] Source phrases outside the soft 1–7s preference: {unusual}")
    if abs(mapping["duration"] - mapping["target_duration"]) > 5:
        print("[提醒] More than 5s from the requested target; review the selection before submission")


if __name__ == "__main__":
    main_guard(main)
