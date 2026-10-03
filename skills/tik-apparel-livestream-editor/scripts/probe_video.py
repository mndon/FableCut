"""Inspect source/extracted audio without changing media; detect unsafe ASR alignment."""
import argparse
import math
from fractions import Fraction

from common import ffprobe, main_guard, number, write_json


ORIGIN_TOLERANCE = 0.1


def source_streams(data):
    streams = data["streams"]
    vs = next((s for s in streams if s["codec_type"] == "video"), None)
    audios = [s for s in streams if s["codec_type"] == "audio"]
    if vs is None or not audios:
        raise ValueError("Source must contain video and speech audio streams")
    if len(audios) != 1:
        raise ValueError("Multiple audio streams: identify the intended speech stream before transcription")
    return vs, audios[0]


def stream_start(stream):
    # Missing timestamps are not evidence that a stream starts at zero.
    value = float(stream["start_time"])
    if not math.isfinite(value):
        raise ValueError("Invalid stream start_time")
    return value


def describe(data, require_aligned=True):
    vs, a = source_streams(data)
    duration = number(data["format"]["duration"], "source.duration", 0.001)
    vstart, astart = stream_start(vs), stream_start(a)
    if require_aligned and abs(vstart - astart) > ORIGIN_TOLERANCE:
        raise ValueError("Audio/video time origins differ by >0.1s; ASR-to-video alignment requires source review")
    result = {"duration": duration, "width": vs["width"], "height": vs["height"],
              "fps": float(Fraction(vs.get("avg_frame_rate") or vs["r_frame_rate"])),
              "video_start": vstart, "audio_start": astart,
              "audio_codec": a["codec_name"], "video_codec": vs["codec_name"]}
    return result


def inspect(video, audio=None):
    result = describe(ffprobe(video))
    if audio:
        adata = ffprobe(audio)
        result["extracted_audio_duration"] = number(adata["format"]["duration"], "extracted.duration")
        if abs(result["duration"] - result["extracted_audio_duration"]) > 0.5:
            raise ValueError("Extracted audio/source durations differ by >0.5s; do not use potentially shifted ASR cuts")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video")
    parser.add_argument("--audio")
    parser.add_argument("--out", required=True, help="Output JSON file")
    args = parser.parse_args()
    info = inspect(args.video, args.audio)
    write_json(args.out, info)
    print(f"[通过] {info['width']}×{info['height']}, {info['fps']:g}fps, {info['duration']:.3f}s")


if __name__ == "__main__":
    main_guard(main)
