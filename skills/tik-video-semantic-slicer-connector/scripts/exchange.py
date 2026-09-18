"""Offline tik-editvideo-cli project handoff. Standard library only; never edits live projects."""
import argparse
from copy import deepcopy
import hashlib
import ipaddress
import json
import math
from pathlib import Path, PurePosixPath
import re
import sys
from urllib.parse import urlsplit

PROTOCOL = "tik-video-semantic-slicer-connector/v1"


def read(path):
    def invalid(value):
        raise ValueError(f"Non-finite JSON value: {value}")
    return json.loads(Path(path).read_text(encoding="utf-8"), parse_constant=invalid)


def digest(value):
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def write_new(path, value):
    with Path(path).open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, label, positive=False):
    require(type(value) in (int, float) and math.isfinite(value), f"Invalid {label}")
    require(value > 0 if positive else value >= 0, f"Invalid {label}")
    return value


def indexed(items, label):
    require(isinstance(items, list), f"{label} must be an array")
    result = {}
    for item in items:
        require(isinstance(item, dict), f"Invalid {label} item")
        ident = item.get("id")
        require(isinstance(ident, str) and ident and ident not in result, f"Missing/duplicate {label} ID")
        result[ident] = item
    return result


def remote_url(value):
    require(isinstance(value, str), "Expected HTTP(S) URL")
    url = urlsplit(value)
    require(url.scheme in ("https", "http") and url.hostname and not url.username and not url.password,
            "Expected HTTP(S) URL without embedded credentials")
    host = url.hostname.lower().rstrip(".")
    require(host != "localhost" and not host.endswith((".localhost", ".local")), "Local URL cannot cross hosts")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        require(address.is_global, "Private/loopback URL cannot cross hosts")
    return value


def remote_source(value):
    if isinstance(value, str) and value.startswith("/mnt/session/uploads/"):
        require(".." not in PurePosixPath(value).parts and "\\" not in value, "Invalid mount path")
        return value
    return remote_url(value)


def validate_project(project):
    require(isinstance(project, dict), "Expected native project object")
    for key in ("width", "height", "fps"):
        number(project.get(key), key, positive=True)
    require(type(project.get("revision")) is int and project["revision"] >= 0, "Invalid project revision")
    media = indexed(project.get("media"), "media")
    require(media, "Project has no media")
    for item in media.values():
        require(item.get("kind") in ("video", "audio", "image", "svg"), "Invalid media kind")
        require(isinstance(item.get("src"), str) and item["src"], "Missing media src")
        if item["kind"] in ("video", "audio"):
            number(item.get("duration"), "media duration", positive=True)
    clips = indexed(project.get("clips"), "clip")
    for clip in clips.values():
        kind = clip.get("kind")
        require(kind in ("video", "audio", "image", "svg", "text", "adjust"), "Invalid clip kind")
        require(re.fullmatch(r"[VA][1-4]", str(clip.get("track", ""))), "Invalid clip track")
        number(clip.get("start"), "clip start")
        number(clip.get("duration"), "clip duration", positive=True)
        offset = number(clip.get("in", 0), "clip in")
        props = clip.get("props", {})
        require(isinstance(props, dict), "Invalid clip props")
        speed = number(props.get("speed", 1), "clip speed", positive=True)
        keys = clip.get("keyframes", {})
        require(isinstance(keys, dict) and not keys.get("speed"), "Variable speed requires manual validation")
        if kind in ("text", "adjust"):
            require(clip.get("mediaId") is None, "Text/adjust clip must not reference media")
            continue
        item = media.get(clip.get("mediaId"))
        require(item is not None, "Clip references unknown media")
        require(item["kind"] == kind or (kind == "audio" and item["kind"] == "video"), "Clip/media kind mismatch")
        if item["kind"] in ("video", "audio"):
            require(offset + clip["duration"] * speed <= item["duration"] + 0.001,
                    "Clip exceeds source duration")
    return media


def export_project(project, bindings, requirements, project_id, run_id):
    media = validate_project(project)
    require(re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project_id), "Invalid client project ID")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", run_id), "Invalid run ID")
    require(isinstance(requirements, dict), "Requirements must be an object")
    require(isinstance(bindings, dict), "Bindings must be an object")
    rows = bindings.get("sources")
    require(isinstance(rows, list) and rows, "Bindings need sources")
    exported = deepcopy(project)
    exported_media = indexed(exported["media"], "media")
    seen, source_ids, sources = set(), set(), []
    for row in rows:
        require(isinstance(row, dict), "Invalid source binding")
        mid, sid = row.get("media_id"), row.get("id")
        require(mid in media and mid not in seen, "Unknown/duplicate binding media_id")
        require(isinstance(sid, str) and re.fullmatch(r"s[1-9][0-9]*", sid) and sid not in source_ids,
                "Source IDs must be unique s1, s2, ...")
        seen.add(mid)
        source_ids.add(sid)
        require(media[mid]["kind"] == "video", "Connector input supports prepared speech videos only")
        remote_source(row.get("remote_src"))
        remote_url(media[mid].get("asrUrl"))
        require(re.fullmatch(r"[a-f0-9]{64}", row.get("sha256", "")), "Prepared source SHA-256 required")
        exported_media[mid]["src"] = row["remote_src"]
        source = {"id": sid, "media_id": mid, "sha256": row["sha256"]}
        if "range" in row:
            scope = row["range"]
            require(isinstance(scope, list) and len(scope) == 2, "Range must be [start, end]")
            start, end = number(scope[0], "range start"), number(scope[1], "range end")
            require(start < end <= media[mid]["duration"] + 0.001, "Invalid source range")
            source["range"] = scope
        sources.append(source)
    require(seen == set(media), "Every media needs a binding; use a dedicated input project")
    request = {"protocol": PROTOCOL, "run_id": run_id, "project_sha256": digest(exported),
               "requirements": requirements, "sources": sources}
    state = {"protocol": PROTOCOL, "run_id": run_id, "client_project_id": project_id,
             "base_project": deepcopy(project), "base_sha256": digest(project), "request": request}
    return exported, request, state


def seal_result(request, project, verification):
    validate_project(project)
    require(request.get("protocol") == PROTOCOL, "Unsupported request protocol")
    require(isinstance(verification, dict) and verification.get("geometry") == "passed", "Geometry verification required")
    require(verification.get("audiovisual") in ("passed", "pending"), "Audiovisual state required")
    return {"protocol": PROTOCOL, "run_id": request["run_id"], "status": "completed",
            "input_project_sha256": request["project_sha256"], "project_sha256": digest(project),
            "verification": verification}


def receive_project(state, current, returned, result, project_id):
    require(state.get("protocol") == PROTOCOL and result.get("protocol") == PROTOCOL, "Unsupported protocol")
    require(project_id == state["client_project_id"], "Wrong client project")
    require(digest(state["base_project"]) == state["base_sha256"], "Local base snapshot was modified")
    require(digest(current) == state["base_sha256"], "CONFLICT: client changed since dispatch; preserve result separately")
    require(result.get("run_id") == state["run_id"] and result.get("status") == "completed", "Wrong run or incomplete result")
    require(result.get("input_project_sha256") == state["request"]["project_sha256"], "Wrong input project")
    require(result.get("project_sha256") == digest(returned), "Result project hash mismatch")
    verification = result.get("verification", {})
    require(verification.get("geometry") == "passed" and verification.get("audiovisual") in ("passed", "pending"),
            "Missing result verification")
    original = validate_project(current)
    remote = validate_project(returned)
    require(set(original) == set(remote), "Server changed media IDs; reconcile before importing")
    for ident, item in original.items():
        require(all(remote[ident].get(k) == item.get(k) for k in ("kind", "duration", "asrUrl")),
                "Server changed source identity/duration/ASR binding")
    require(returned["clips"], "Empty result timeline")
    duration = max(c["start"] + c["duration"] for c in returned["clips"])
    require(35 - 0.001 <= duration <= 90 + 0.001, "Result outside slicer 35–90s contract")
    require(returned.get("inPoint") in (None, 0) and returned.get("outPoint") in (None, 0, duration),
            "Result has restricted export range")
    restored = deepcopy(returned)
    # Remote revisions belong to a different store. CAS uses the unchanged CLIENT revision.
    restored["revision"] = current["revision"]
    restored["media"] = deepcopy(current["media"])
    validate_project(restored)
    return restored


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export")
    for name in ("project", "bindings", "requirements", "project-id", "run-id", "out-dir"):
        export.add_argument("--" + name, required=True)
    seal = commands.add_parser("seal-result")
    for name in ("request", "project", "verification", "output"):
        seal.add_argument("--" + name, required=True)
    receive = commands.add_parser("receive")
    for name in ("state", "current", "project", "result", "project-id", "output"):
        receive.add_argument("--" + name, required=True)
    args = parser.parse_args()
    if args.command == "export":
        project, request, state = export_project(read(args.project), read(args.bindings), read(args.requirements),
                                               args.project_id, args.run_id)
        out = Path(args.out_dir)
        out.mkdir(parents=True, exist_ok=False)
        write_new(out / "project.json", project)
        write_new(out / "request.json", request)
        write_new(out / "client-state.json", state)
    elif args.command == "seal-result":
        write_new(args.output, seal_result(read(args.request), read(args.project), read(args.verification)))
    else:
        restored = receive_project(read(args.state), read(args.current), read(args.project), read(args.result), args.project_id)
        write_new(args.output, restored)
    print(json.dumps({"ok": True, "command": args.command}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as exc:
        print(f"Exchange failed: {exc}", file=sys.stderr)
        sys.exit(1)
