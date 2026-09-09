"""Deterministic source index, hook candidates, and project-backed final script."""
import argparse

from build_edit_ops import check_project_mapping, refined_parts
from common import MODULES, main_guard, number, read_json, unique_map, validate_selection


def cell(value):
    return str(value).replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def render_index(sentences):
    return "\n".join(f"{s['index']} [{s['source_id']} {s['speaker_id']}"
                     f"{' 范围外' if not s['eligible'] else ''}] {cell(s['text'])}"
                     for s in sentences["sentences"])


def render(sentences, config=None, selection=None, hook=None, speed=None, project=None, mapping=None, label=None):
    indexed = unique_map(sentences["sentences"], "index")
    if hook is not None:
        if not hook or len(set(hook)) != len(hook) or any(i not in indexed for i in hook):
            raise ValueError("Hook indices must be nonempty, valid and unique")
        if any(not indexed[i]["eligible"] for i in hook):
            raise ValueError("Hook contains out-of-range material")
        groups = {"hook": hook}
        if project is not None or mapping is not None:
            raise ValueError("Project mapping is for full script display")
    else:
        validate_selection(sentences, selection, config)
        groups = config["groups"]
        speed = number(config["speed"], "speed", 0.25, 4)
    rows = {}
    if (project is None) != (mapping is None):
        raise ValueError("--project and --mapping must be supplied together")
    if project is not None:
        if mapping["groups"] != groups:
            raise ValueError("Current groups differ from the submitted mapping")
        actual = check_project_mapping(project, mapping)
        for entry in mapping["entries"]:
            expected = entry["clip"]
            if expected["kind"] != "video":
                continue
            clip = actual[expected["id"]]
            rows.setdefault(entry["index"], []).append((entry["source_id"], clip["in"],
                clip["in"] + clip["duration"] * clip["props"]["speed"],
                clip["start"], clip["start"] + clip["duration"], entry["text"]))
        title = f"成片脚本（已核对工程，共 {sum(len(v) for v in rows.values())} 个视频片段）"
    else:
        # Before speed is agreed, never silently label an assumed speed as the final timing.
        agreed_speed = number(speed, "speed", 0.25, 4) if speed is not None else None
        cursor = 0.0
        transition = (config or {}).get("transition", {"type": "none"})
        overlap = 0 if transition["type"] == "none" else number(transition.get("duration", 0.3), "transition.duration")
        for module in MODULES:
            for index in groups.get(module["key"], []):
                s = indexed[index]
                parts = refined_parts(s, (config or {}).get("refinements", {}))
                for start, end, text in parts:
                    if rows:
                        cursor -= overlap
                    duration = (end - start) / agreed_speed if agreed_speed else None
                    rows.setdefault(index, []).append((s["source_id"], start, end,
                        cursor if duration is not None else None,
                        cursor + duration if duration is not None else None, text))
                    if duration is not None:
                        cursor += duration
        title = "钩子候选" if hook is not None else "成片脚本草案"
        title += f"（{agreed_speed:g}x 预计时间）" if agreed_speed else "（倍速待定，暂不计算成片时间）"
    output = [title, ""]
    for module in MODULES:
        indices = groups.get(module["key"], [])
        if not indices:
            continue
        suffix = f"｜{cell(label)}" if label and hook is not None else ""
        output.extend([f"### {module['title']}{suffix}", "",
                       "| 编号 | 源时间 | 秒 | 成片时间 | 文本 |",
                       "| --- | --- | --- | --- | --- |"])
        for index in indices:
            for source, start, end, begin, finish, text in rows[index]:
                timing = "待定" if begin is None else f"{begin:.3f}–{finish:.3f}"
                output.append(f"| {index} | {cell(source)} {start:.3f}–{end:.3f} | {end-start:.3f} | {timing} | {cell(text)} |")
        output.append("")
    return "\n".join(output).rstrip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sentences", required=True)
    parser.add_argument("--index", action="store_true")
    parser.add_argument("--hook", help="Comma-separated stable indices; candidate mode only")
    parser.add_argument("--speed", type=float, help="Candidate timing only, when speed is already agreed")
    for name in ("selection", "config", "project", "mapping", "label"):
        parser.add_argument("--" + name)
    args = parser.parse_args()
    sentences = read_json(args.sentences)
    if args.index:
        if any((args.hook, args.selection, args.config, args.project, args.mapping)):
            raise ValueError("--index cannot be combined with selection/project options")
        print(render_index(sentences))
    else:
        hook = [int(i) for i in args.hook.split(",")] if args.hook is not None else None
        if hook is None and (not args.selection or not args.config):
            raise ValueError("Full script requires --selection and --config")
        print(render(sentences, read_json(args.config) if args.config else None,
                     read_json(args.selection) if args.selection else None, hook, args.speed,
                     read_json(args.project) if args.project else None,
                     read_json(args.mapping) if args.mapping else None, args.label))


if __name__ == "__main__":
    main_guard(main)
