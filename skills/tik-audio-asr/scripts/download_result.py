#!/usr/bin/env python3
"""Download an existing ASR result without transcription or API credentials."""
import argparse
import http.client
import json
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from transcribe import (
    ToolError, ssl_context as download_ssl_context,
    validate_json_url, validate_editor_result,
)


def download_result(url, output):
    validate_json_url(url)
    path = Path(output)
    if path.exists():
        raise ToolError("FILE_EXISTS", "目标文件已存在，请复用或选择新路径")
    try:
        with urlopen(url, timeout=60, context=download_ssl_context()) as response:
            body = response.read()
    except (URLError, OSError, http.client.HTTPException) as exc:
        raise ToolError("DOWNLOAD_FAILED", "ASR JSON 下载失败，请检查链接是否可访问") from exc
    try:
        data = json.loads(body)
        validate_editor_result(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ToolError("INVALID_RESPONSE", "ASR JSON 内容无效") from exc
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as target:
        target.write(body)
    return {"path": str(path.resolve())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(download_result(args.url, args.output), ensure_ascii=False))
        return 0
    except ToolError as exc:
        error = {"code": exc.code, "message": exc.message}
    except OSError:
        error = {"code": "FILE_FAILED", "message": "无法保存 ASR JSON 文件"}
    except KeyboardInterrupt:
        error = {"code": "CANCELLED", "message": "已取消下载"}
    print(json.dumps({"error": error}, ensure_ascii=False), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
