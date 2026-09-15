#!/usr/bin/env python3
"""提客 AI 本地音频转写命令行程序。"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import math
import os
import ssl
import subprocess
import tempfile
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

API_BASE_URL = "http://127.0.0.1:8000/open"
CLIENT_ID = "10104"
SUCCESS_STATUS = 2000
AUTH_FAILURE_STATUSES = {4010, 4011}
POLL_INTERVAL_SECONDS = 3
TIMEOUT_SECONDS = 30 * 60
SUPPORTED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".ts", ".mts", ".m2ts", ".wmv"}


class ToolError(Exception):
    """可安全展示给调用方的错误。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class AudioMetadata:
    path: Path
    duration_seconds: float
    size_bytes: int
    extension: str
    file_md5: str


def skill_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_config() -> str:
    api_key = os.environ.get("TIK_API_KEY", "").strip()
    if not api_key:
        raise ToolError("CONFIG_MISSING", "缺少环境变量 TIK_API_KEY")
    return api_key


def ssl_context() -> ssl.SSLContext:
    """Create an HTTPS context without certificate verification for compatibility."""
    return ssl._create_unverified_context()


def network_error(exc: URLError | OSError, operation: str) -> ToolError:
    return ToolError("API_FAILED", f"{operation}失败，请检查网络连接")


def calculate_md5(path: Path) -> str:
    digest = hashlib.md5()  # nosec B324: 服务接口要求文件 MD5，不用于安全用途。
    with path.open("rb") as audio_file:
        for chunk in iter(lambda: audio_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_u32(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset:offset + 4], "big")


def read_wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as audio_file:
        frame_rate = audio_file.getframerate()
        if frame_rate <= 0:
            raise ValueError("invalid WAV frame rate")
        return audio_file.getnframes() / frame_rate


def read_m4a_duration(path: Path) -> float:
    # ISO BMFF 的 mdhd atom 保存媒体时间尺度和持续时间。
    data = path.read_bytes()
    offset = 0
    while True:
        offset = data.find(b"mdhd", offset)
        if offset < 4:
            raise ValueError("mdhd atom not found")
        atom_start = offset - 4
        if atom_start + 32 > len(data):
            raise ValueError("truncated mdhd atom")
        version = data[offset + 4]
        if version == 0:
            timescale, duration = read_u32(data, offset + 16), read_u32(data, offset + 20)
        elif version == 1 and atom_start + 44 <= len(data):
            timescale = read_u32(data, offset + 24)
            duration = int.from_bytes(data[offset + 28:offset + 36], "big")
        else:
            offset += 4
            continue
        if timescale > 0 and duration > 0:
            return duration / timescale
        offset += 4


def read_aac_duration(path: Path) -> float:
    # ADTS AAC：每个帧固定为 1024 个采样；原始 AAC 流没有足够元数据。
    sample_rates = (96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
                    16000, 12000, 11025, 8000, 7350)
    data = path.read_bytes()
    position, samples, sample_rate = 0, 0, 0
    while position + 7 <= len(data):
        if data[position] != 0xFF or data[position + 1] & 0xF6 != 0xF0:
            raise ValueError("invalid ADTS frame")
        frequency_index = (data[position + 2] >> 2) & 0x0F
        if frequency_index >= len(sample_rates):
            raise ValueError("invalid AAC sample rate")
        sample_rate = sample_rates[frequency_index]
        protection_absent = data[position + 1] & 0x01
        header_size = 7 if protection_absent else 9
        frame_length = ((data[position + 3] & 0x03) << 11) | (data[position + 4] << 3) | (data[position + 5] >> 5)
        if frame_length < header_size or position + frame_length > len(data):
            raise ValueError("invalid ADTS frame length")
        samples += 1024
        position += frame_length
    if position != len(data) or samples == 0 or sample_rate == 0:
        raise ValueError("no AAC frames")
    return samples / sample_rate


def read_mp3_duration(path: Path) -> float:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_type:format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, check=True, timeout=60,
        )
    except FileNotFoundError as exc:
        raise ToolError("DEPENDENCY_MISSING", "读取 MP3 时长需要安装 ffprobe") from exc
    except (subprocess.SubprocessError, OSError) as exc:
        raise ToolError("AUDIO_METADATA_INVALID", "无法读取有效的音频时长") from exc
    metadata = json.loads(result.stdout)
    if not metadata.get("streams"):
        raise ValueError("no audio stream")
    duration = float(metadata["format"]["duration"])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("invalid duration")
    return duration


def extract_audio(video_path: Path, audio_path: Path) -> None:
    try:
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(video_path),
             "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "libmp3lame", "-q:a", "4", str(audio_path)],
            capture_output=True, check=True,
        )
    except FileNotFoundError as exc:
        raise ToolError("DEPENDENCY_MISSING", "从视频提取音频需要安装 ffmpeg") from exc
    except (subprocess.SubprocessError, OSError) as exc:
        raise ToolError("AUDIO_EXTRACTION_FAILED", "音频提取失败，请确认视频可读取且包含音轨") from exc


def read_duration(path: Path, extension: str) -> float:
    if extension == ".wav":
        return read_wav_duration(path)
    if extension == ".m4a":
        return read_m4a_duration(path)
    if extension == ".aac":
        return read_aac_duration(path)
    return read_mp3_duration(path)


def read_metadata(audio_path: str) -> AudioMetadata:
    path = Path(audio_path)
    if not path.is_absolute():
        raise ToolError("FILE_INVALID", "audio_path 必须是绝对路径")
    path = path.resolve()
    extension = path.suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ToolError("FILE_INVALID", "仅支持 MP3、WAV、M4A、AAC 音频")
    try:
        stat = path.stat()
    except OSError as exc:
        raise ToolError("FILE_INVALID", f"音频文件不存在：{path}") from exc
    if not path.is_file() or stat.st_size <= 0:
        raise ToolError("FILE_INVALID", "audio_path 必须指向非空音频文件")
    try:
        duration = read_duration(path, extension)
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("invalid duration")
    except ToolError:
        raise
    except Exception as exc:
        raise ToolError("AUDIO_METADATA_INVALID", "无法读取有效的音频时长") from exc
    return AudioMetadata(path, float(duration), stat.st_size, extension, calculate_md5(path))


class TikAiClient:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    def api_request(self, path: str, method: str, payload: dict[str, Any] | None = None) -> Any:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{API_BASE_URL}{path}",
            data=data,
            method=method,
            headers={
                "Accept": "application/json",
                "Client-ID": CLIENT_ID,
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
        )
        try:
            with urlopen(request, timeout=60, context=ssl_context()) as response:
                status_code = response.status
                response_body = response.read()
        except HTTPError as exc:
            status_code, response_body = exc.code, exc.read()
        except (URLError, OSError) as exc:
            raise network_error(exc, "OpenAPI 请求") from exc
        try:
            envelope = json.loads(response_body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ToolError("INVALID_RESPONSE", "OpenAPI 返回了无效 JSON") from exc
        if not isinstance(envelope, dict) or not isinstance(envelope.get("status"), int):
            raise ToolError("INVALID_RESPONSE", "OpenAPI 返回了无效响应结构")
        business_status = envelope["status"]
        if status_code == 401 or business_status in AUTH_FAILURE_STATUSES:
            raise ToolError("AUTH_EXPIRED", "OpenAPI API Key 无效或已失效")
        if not 200 <= status_code < 300:
            raise ToolError("API_FAILED", f"OpenAPI 请求失败，HTTP {status_code}")
        if business_status != SUCCESS_STATUS:
            message = envelope.get("remark") or envelope.get("msg") or "请求失败"
            message = str(message).replace(self.api_key, "[REDACTED]")
            raise ToolError("API_FAILED", f"OpenAPI 接口失败，业务状态 {business_status}: {message}")
        return envelope.get("data")

    def upload_audio(self, upload_url: str, audio_path: Path) -> None:
        parsed = urlsplit(upload_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ToolError("INVALID_RESPONSE", "服务端未返回有效的音频上传地址")
        target = parsed.path or "/"
        if parsed.query:
            target = f"{target}?{parsed.query}"
        if parsed.scheme == "https":
            connection = http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=60, context=ssl_context())
        else:
            connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=60)
        try:
            connection.putrequest("PUT", target)
            connection.putheader("Content-Length", str(audio_path.stat().st_size))
            connection.endheaders()
            with audio_path.open("rb") as audio_file:
                for chunk in iter(lambda: audio_file.read(1024 * 1024), b""):
                    connection.send(chunk)
            response = connection.getresponse()
            response.read()
            if not 200 <= response.status < 300:
                raise ToolError("UPLOAD_FAILED", f"音频上传失败，HTTP {response.status}")
        except ToolError:
            raise
        except (OSError, http.client.HTTPException) as exc:
            if isinstance(exc, OSError):
                raise network_error(exc, "音频上传") from exc
            raise ToolError("UPLOAD_FAILED", "音频上传失败") from exc
        finally:
            connection.close()


def validate_rich_result(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or isinstance(value.get("duration"), bool) or not isinstance(value.get("duration"), (int, float)) or value["duration"] < 0:
        raise ToolError("INVALID_RESPONSE", "服务端未返回有效的 rich_result")
    sentences = value.get("sentences")
    if not isinstance(sentences, list):
        raise ToolError("INVALID_RESPONSE", "服务端未返回有效的 rich_result")
    for sentence in sentences:
        if not isinstance(sentence, dict) or not all(key in sentence for key in ("begin_time", "end_time", "text", "channel_id", "words")):
            raise ToolError("INVALID_RESPONSE", "服务端未返回有效的 rich_result")
        if (isinstance(sentence["begin_time"], bool) or not isinstance(sentence["begin_time"], (int, float)) or
                isinstance(sentence["end_time"], bool) or not isinstance(sentence["end_time"], (int, float)) or
                not isinstance(sentence["text"], str) or isinstance(sentence["channel_id"], bool) or
                not isinstance(sentence["channel_id"], int) or not isinstance(sentence["words"], list)):
            raise ToolError("INVALID_RESPONSE", "服务端未返回有效的 rich_result")
        for word in sentence["words"]:
            if not isinstance(word, dict) or not all(key in word for key in ("begin_time", "end_time", "word", "punc", "channel_id")):
                raise ToolError("INVALID_RESPONSE", "服务端未返回有效的 rich_result")
            if (isinstance(word["begin_time"], bool) or not isinstance(word["begin_time"], (int, float)) or
                    isinstance(word["end_time"], bool) or not isinstance(word["end_time"], (int, float)) or
                    not isinstance(word["word"], str) or not isinstance(word["punc"], str) or
                    isinstance(word["channel_id"], bool) or not isinstance(word["channel_id"], int)):
                raise ToolError("INVALID_RESPONSE", "服务端未返回有效的 rich_result")
    return value


def validate_channels(value: Any, rich: dict[str, Any] | None) -> list[int]:
    if not isinstance(value, list) or any(type(cid) is not int for cid in value) or len(set(value)) != len(value):
        raise ToolError("INVALID_RESPONSE", "ASR 结果需要有效的 channel 数组，不支持旧格式")
    if rich is not None:
        for sentence in rich["sentences"]:
            if sentence["channel_id"] not in value:
                raise ToolError("INVALID_RESPONSE", "channel 未包含句子中的声音 ID")
    return value


def validate_editor_result(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or "rich_result" not in value:
        raise ToolError("INVALID_RESPONSE", "ASR 结果缺少 rich_result")
    rich = value["rich_result"]
    if rich is not None:
        validate_rich_result(rich)
    channels = validate_channels(value.get("channel"), rich)
    return {"rich_result": rich, "channel": channels}


def validate_json_url(value: Any) -> str:
    try:
        parsed = urlsplit(value) if isinstance(value, str) else None
        if (not parsed or parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or any(c.isspace() for c in value)):
            raise ValueError("invalid URL")
        parsed.port
    except ValueError as exc:
        raise ToolError("INVALID_RESPONSE", "ASR 结果链接必须是有效的 HTTP(S) URL") from exc
    return value


def transcribe(audio_path: str) -> dict[str, Any]:
    path = Path(audio_path)
    if not path.is_absolute():
        raise ToolError("FILE_INVALID", "输入必须是本地音频或视频的绝对路径")
    if path.suffix.lower() in VIDEO_EXTENSIONS:
        if not path.is_file() or path.stat().st_size == 0:
            raise ToolError("FILE_INVALID", "输入必须指向非空视频文件")
        # Fail before extraction when credentials are missing.
        load_config()
        with tempfile.TemporaryDirectory(prefix="tik-audio-asr-") as directory:
            extracted = Path(directory) / (path.stem + ".mp3")
            extract_audio(path, extracted)
            return transcribe_audio(str(extracted))
    return transcribe_audio(audio_path)


def transcribe_audio(audio_path: str) -> dict[str, Any]:
    metadata = read_metadata(audio_path)
    client = TikAiClient(load_config())
    task = client.api_request("/api/v2/toolExtract", "POST", {
        "title": metadata.path.name,
        "origin_type": "AUDIO",
        "client_meta": {
            "desktop_size": metadata.size_bytes,
            "desktop_time": str(metadata.duration_seconds),
            "desktop_timeLength": metadata.duration_seconds,
            "desktop_file_name": metadata.path.name,
        },
        "without_merge_word": True,
    })
    task_id = task.get("Id", task.get("id")) if isinstance(task, dict) else None
    if isinstance(task_id, bool) or not isinstance(task_id, int) or task_id <= 0:
        raise ToolError("INVALID_RESPONSE", "服务端未返回有效的任务 ID")
    upload = client.api_request(f"/api/v2/toolExtract/{task_id}/applyAudioUploadAddresses", "POST", {
        "duration": metadata.duration_seconds,
        "file_size": metadata.size_bytes,
        "file_md5": metadata.file_md5,
        "file_format": metadata.extension.lstrip("."),
        "split_part": 1,
    })
    if not isinstance(upload, dict) or not isinstance(upload.get("exist"), bool):
        raise ToolError("INVALID_RESPONSE", "服务端未返回有效的音频上传地址")
    if upload["exist"] and upload.get("urls") is None:
        upload["urls"] = []
    if not isinstance(upload.get("urls"), list):
        raise ToolError("INVALID_RESPONSE", "服务端未返回有效的音频上传地址")
    if not upload["exist"]:
        urls = upload["urls"]
        if not urls or not isinstance(urls[0], str) or not urls[0]:
            raise ToolError("INVALID_RESPONSE", "服务端未返回有效的音频上传地址")
        client.upload_audio(urls[0], metadata.path)
    client.api_request(f"/api/v2/toolExtract/{task_id}/audioTask", "POST", {"split": True, "for_editor": 1})
    deadline = time.monotonic() + TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        detail = client.api_request(f"/api/v2/toolExtract/{task_id}", "GET")
        status = detail.get("parse_status") if isinstance(detail, dict) else None
        if status == 3:
            return {"json_url": validate_json_url(detail.get("result_url"))}
        if status == 4:
            raise ToolError("TRANSCRIPTION_FAILED", "服务端音频解析异常")
        if type(status) is not int or status not in (1, 2):
            raise ToolError("INVALID_RESPONSE", f"服务端返回未知解析状态 {status}")
        time.sleep(POLL_INTERVAL_SECONDS)
    raise ToolError("TIMEOUT", "音频转写超过 30 分钟")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    command = sub.add_parser("transcribe")
    command.add_argument("audio_path", help="Absolute audio or video path")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(transcribe(args.audio_path), ensure_ascii=False, separators=(",", ":")))
        return 0
    except KeyboardInterrupt:
        print(json.dumps({"error": {"code": "CANCELLED", "message": "已取消音频转写"}}, ensure_ascii=False), file=sys.stderr)
        return 1
    except ToolError as exc:
        print(json.dumps({"error": {"code": exc.code, "message": exc.message}}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps({"error": {"code": "API_FAILED", "message": "音频转写失败，请稍后重试"}}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
