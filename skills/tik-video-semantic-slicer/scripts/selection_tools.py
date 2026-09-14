"""Local candidate query, timing, editorial review and media-ID binding."""
import argparse
import json

from build_edit_ops import refined_parts
from common import (MODULES, TRANSITIONS, main_guard, number, read_json, selected_units,
                    unique_map, validate_selection, write_json)
from editorial import review_draft, validate_review


def query(sentences, indices, context=0, words=False):
    indexed = unique_map(sentences["sentences"], "index")
    if any(i not in indexed for i in indices):
        raise ValueError("Unknown sentence index")
    keep = set(indices)
    for i in indices:
        keep.update(j for j in range(i - context, i + context + 1)
                    if j in indexed and indexed[j]["source_id"] == indexed[i]["source_id"])
    return [{**{k: v for k, v in indexed[i].items() if words or k != "words"},
             "requested": i in indices} for i in sorted(keep)]


def estimate(sentences, selection, config, content):
    selected = validate_selection(sentences, selection, config, content)
    speed = number(config["speed"], "speed", 0.25, 4)
    target = number(config["target_duration"], "target_duration", 35, 90)
    transition = config.get("transition", {"type": "none"})
    if transition["type"] not in TRANSITIONS:
        raise ValueError("Unknown transition")
    overlap = 0 if transition["type"] == "none" else number(transition.get("duration", 0.3), "transition.duration", 0.001)
    refinements = config.get("refinements", {})
    if set(refinements) - {str(s["index"]) for s in selected}:
        raise ValueError("Refinement references an unselected sentence")
    durations = [(s["index"], (end - start) / speed) for s in selected
                 for start, end, _ in refined_parts(s, refinements)]
    if overlap and any(d <= overlap * ((i > 0) + (i < len(durations) - 1))
                       for i, (_, d) in enumerate(durations)):
        raise ValueError("Transition windows consume a short clip")
    total = sum(d for _, d in durations) - overlap * (len(durations) - 1)
    modules = {m["key"]: sum(d - (overlap if pos else 0) for pos, (i, d) in enumerate(durations)
                            if i in config["groups"][m["key"]]) for m in MODULES}
    return {"duration": round(total, 3), "target_delta": round(total - target, 3),
            "in_range": 35 <= total <= 90, "modules": {k: round(v, 3) for k, v in modules.items()},
            "units": {k: len(selected_units(sentences, content, ids, config["product_id"]))
                      for k, ids in config["groups"].items()}}


def bind_media(sources, source_id, imported):
    source = unique_map(sources["sources"], "id").get(source_id)
    media = imported.get("media", {})
    if source is None or imported.get("ok") is not True or media.get("kind") != "video" or not media.get("id"):
        raise ValueError("Need known source_id and successful import-media JSON")
    if source.get("media_id") not in (None, media["id"]):
        raise ValueError("Source already bound to another media ID; reconcile explicitly")
    source["media_id"] = media["id"]
    return sources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    q = sub.add_parser("query")
    q.add_argument("--sentences", required=True)
    q.add_argument("--indices", required=True, help="Comma-separated indices")
    q.add_argument("--context", type=int, default=0)
    q.add_argument("--words", action="store_true")
    for command in ("estimate", "review-draft", "check-review"):
        p = sub.add_parser(command)
        for name in ("sentences", "selection", "config", "content"):
            p.add_argument("--" + name, required=True)
        if command == "check-review":
            p.add_argument("--review", required=True)
    b = sub.add_parser("bind-media")
    for name in ("sources", "source-id", "import-result"):
        b.add_argument("--" + name, required=True)
    args = parser.parse_args()
    if args.command == "bind-media":
        result = bind_media(read_json(args.sources), args.source_id, read_json(args.import_result))
        write_json(args.sources, result)
        result = {"source_id": args.source_id, "bound": True}
    elif args.command == "query":
        if args.context < 0:
            raise ValueError("context must be nonnegative")
        result = query(read_json(args.sentences), [int(i) for i in args.indices.split(",")], args.context, args.words)
    else:
        data = [read_json(getattr(args, name)) for name in ("sentences", "selection", "config", "content")]
        validate_selection(*data[:3], data[3])
        if args.command == "estimate":
            result = estimate(*data)
        elif args.command == "review-draft":
            result = review_draft(*data)
        else:
            review = read_json(args.review)
            validate_review(*data, review)
            result = {"editorial_record": "complete (not semantic certification)", "media": review["media"]}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main_guard(main)
