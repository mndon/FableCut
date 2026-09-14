"""Report availability only; never read shell profiles or reveal credentials."""
import json
import os
import shutil


def check():
    return {"TIK_API_KEY": "configured" if os.environ.get("TIK_API_KEY", "").strip() else "missing",
            "commands": {name: bool(shutil.which(name)) for name in ("ffmpeg", "ffprobe", "tik-editvideo-cli")}}


if __name__ == "__main__":
    print(json.dumps(check(), ensure_ascii=False))
