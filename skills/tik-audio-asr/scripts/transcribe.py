#!/usr/bin/env python3
"""提客 AI 本地音频转写命令行程序。"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import ssl
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

API_BASE_URL = "https://skgw-tik.tttci.com/open"
CLIENT_ID = "10104"
SUCCESS_STATUS = 2000
AUTH_FAILURE_STATUSES = {4010, 4011}
POLL_INTERVAL_SECONDS = 3
TIMEOUT_SECONDS = 30 * 60
SUPPORTED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac"}


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
    # 对 CBR 文件按首帧比特率计算；含 Xing/VBRI 头的 VBR 文件使用帧数计算。
    data = path.read_bytes()
    start = 10 + int.from_bytes(data[6:10], "big") if data[:3] == b"ID3" and len(data) >= 10 else 0
    if start >= len(data):
        raise ValueError("empty MP3")
    for offset in range(start, len(data) - 4):
        header = int.from_bytes(data[offset:offset + 4], "big")
        if header >> 21 & 0x7FF != 0x7FF:
            continue
        version_bits, layer_bits = (header >> 19) & 0x03, (header >> 17) & 0x03
        bitrate_index, sample_rate_index = (header >> 12) & 0x0F, (header >> 10) & 0x03
        if version_bits == 1 or layer_bits != 1 or bitrate_index in {0, 15} or sample_rate_index == 3:
            continue
        version = {3: 1, 2: 2, 0: 25}[version_bits]
        sample_rates = {1: (44100, 48000, 32000), 2: (22050, 24000, 16000), 25: (11025, 12000, 8000)}
        bitrates = {1: (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320), 2: (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)}
        sample_rate, bitrate = sample_rates[version][sample_rate_index], bitrates[1 if version == 1 else 2][bitrate_index] * 1000
        samples_per_frame = 1152 if version == 1 else 576
        frame_size = (144 if version == 1 else 72) * bitrate // sample_rate + ((header >> 9) & 1)
        xing_offset = offset + 4 + (32 if version == 1 and (header >> 6) & 3 == 3 else 17 if version != 1 and (header >> 6) & 3 == 3 else 0)
        marker = data[xing_offset:xing_offset + 4]
        if marker in {b"Xing", b"Info"} and xing_offset + 12 <= len(data) and read_u32(data, xing_offset + 4) & 1:
            return read_u32(data, xing_offset + 8) * samples_per_frame / sample_rate
        vbri_offset = offset + 36
        if data[vbri_offset:vbri_offset + 4] == b"VBRI" and vbri_offset + 18 <= len(data):
            return read_u32(data, vbri_offset + 14) * samples_per_frame / sample_rate
        if frame_size <= 0:
            raise ValueError("invalid MP3 frame size")
        return (len(data) - offset) * 8 / bitrate
    raise ValueError("MP3 frame not found")


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
        if duration <= 0:
            raise ValueError("invalid duration")
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


def transcribe(audio_path: str) -> dict[str, Any]:
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
        "return_mode": 1 if os.environ.get("TIK_AUDIO_ASR_RETURN_MODE", "0").strip() == "1" else 0,
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
    client.api_request(f"/api/v2/toolExtract/{task_id}/audioTask", "POST", {"split": True})
    deadline = time.monotonic() + TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        detail = client.api_request(f"/api/v2/toolExtract/{task_id}", "GET")
        status = detail.get("parse_status") if isinstance(detail, dict) else None
        if status == 3:
            rich_result = validate_rich_result(detail.get("rich_result"))
            channels = sorted({sentence["channel_id"] for sentence in rich_result["sentences"]})
            return {"rich_result": rich_result, "speaker_mapping": {str(channel): f"说话人{index}" for index, channel in enumerate(channels, 1)}}
        if status == 4:
            raise ToolError("NO_SPEECH", "音频中未检测到有效说话声")
        if status != 2:
            raise ToolError("INVALID_RESPONSE", f"服务端返回未知解析状态 {status}")
        time.sleep(POLL_INTERVAL_SECONDS)
    raise ToolError("TIMEOUT", "音频转写超过 30 分钟")


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "transcribe":
        print("Usage: python3 scripts/transcribe.py transcribe <absolute-audio-path>", file=sys.stderr)
        return 2
    try:
        print(json.dumps(transcribe(argv[1]), ensure_ascii=False, separators=(",", ":")))
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
