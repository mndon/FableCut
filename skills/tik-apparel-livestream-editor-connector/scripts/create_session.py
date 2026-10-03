"""Create a mounted Managed Agent session using the documented REST API.

bl 1.26.0 session create has no resources argument. Other operations use bl.
Credentials stay in memory and curl stdin; no shell or credential-bearing argv.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from urllib.parse import urlsplit

from exchange import read, require, write_new


def validate_payload(payload):
    require(isinstance(payload, dict), "Session request must be an object")
    require(set(payload) <= {"agent", "environment_id", "title", "resources", "metadata"},
            "Only agent/environment/title/resources/metadata are supported")
    for field, prefix in (("agent", "agent_"), ("environment_id", "env_")):
        require(isinstance(payload.get(field), str) and re.fullmatch(prefix + r"[A-Za-z0-9]+", payload[field]),
                f"Real {field} ID required")
    require(isinstance(payload.get("resources"), list) and payload["resources"], "Mounted files required")
    paths = set()
    for resource in payload["resources"]:
        require(isinstance(resource, dict) and set(resource) == {"type", "file_id", "mount_path"}, "Invalid resource")
        require(resource["type"] == "file" and re.fullmatch(r"file_[A-Za-z0-9]+", resource["file_id"]), "Invalid file ID")
        path = resource["mount_path"]
        require(isinstance(path, str) and path.startswith("/uploads/") and ".." not in PurePosixPath(path).parts
                and "\\" not in path and str(PurePosixPath(path)) == path and path not in paths, "Invalid/duplicate mount path")
        paths.add(path)


def credentials(config_file):
    config = read(config_file) if Path(config_file).is_file() else {}
    key = os.environ.get("DASHSCOPE_API_KEY") or config.get("api_key")
    base = os.environ.get("BAILIAN_BASE_URL") or config.get("base_url")
    require(isinstance(key, str) and key and "\n" not in key and "\r" not in key, "Missing API key; use bl auth login")
    require(isinstance(base, str), "Missing workspace endpoint")
    parsed = urlsplit(base)
    require(parsed.scheme == "https" and parsed.hostname and
            re.fullmatch(r"[a-zA-Z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com", parsed.hostname) and
            parsed.port in (None, 443) and not parsed.username and not parsed.password and
            not parsed.query and not parsed.fragment and parsed.path in ("", "/", "/api/v1/agentstudio"),
            "Expected a cn-beijing workspace HTTPS endpoint")
    return key, f"https://{parsed.netloc}/api/v1/agentstudio/sessions"


def create(payload, config_file, output):
    validate_payload(payload)
    key, url = credentials(config_file)
    output = Path(output)
    require(not output.exists(), "Session output already exists")
    # An ambiguous network failure must not lead to a duplicate session on retry.
    attempt = output.with_name(output.name + ".attempt.json")
    write_new(attempt, {"agent": payload["agent"], "environment_id": payload["environment_id"],
                        "title": payload.get("title"), "status": "attempted"})
    body = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    config = "\n".join([
        "url = " + json.dumps(url), 'request = "POST"',
        "header = " + json.dumps("Authorization: Bearer " + key),
        'header = "Content-Type: application/json"',
        "data = " + json.dumps(body, ensure_ascii=False),
    ])
    try:
        completed = subprocess.run(["curl", "--config", "-", "--silent", "--show-error", "--fail-with-body",
                                    "--connect-timeout", "15", "--max-time", "60"],
                                   input=config, text=True, capture_output=True, timeout=65)
    except (subprocess.TimeoutExpired, OSError):
        raise ValueError("Session creation outcome unknown; inspect sessions before retrying") from None
    if completed.returncode:
        # Raw errors/responses may contain environment variables or credential echoes.
        raise ValueError(f"Session request failed (curl exit {completed.returncode}); inspect sessions before retrying")
    try:
        response = json.loads(completed.stdout)
        ident = response.get("id")
        require(isinstance(ident, str) and re.fullmatch(r"sesn_[A-Za-z0-9]+", ident), "Missing session ID")
    except (ValueError, AttributeError):
        raise ValueError("Unexpected session response; inspect sessions before retrying") from None
    record = {"session_id": ident, "status": response.get("status"), "agent_id": payload["agent"],
              "environment_id": payload["environment_id"], "resources": payload["resources"]}
    write_new(output, record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, help="Session API request JSON")
    parser.add_argument("--output", required=True, help="New local session record")
    parser.add_argument("--auth-config", default=str(Path.home() / ".bailian/config.json"),
                        help="Explicit bl credential config; default profile only unless overridden")
    args = parser.parse_args()
    record = create(read(args.request), args.auth_config, args.output)
    print(json.dumps({"session_id": record["session_id"], "status": record["status"]}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as exc:
        print(f"Session creation failed: {exc}", file=sys.stderr)
        sys.exit(1)
