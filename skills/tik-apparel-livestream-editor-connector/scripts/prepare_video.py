"""Prepare one shared ASR/editing source, copying video and aligning audio to it."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from media_common import ffprobe, main_guard, number
from probe_video import ORIGIN_TOLERANCE, describe, source_streams, stream_start


def video_duration(path, stream):
    if stream.get("duration") not in (None, "N/A"):
        return number(stream["duration"], "video.duration", 0.001)
    # Some containers have no per-stream duration. Scan packet timestamps only,
    # without decoding frames or loading the whole packet list into memory.
    command = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_packets",
               "-show_entries", "packet=pts_time,duration_time", "-of", "compact=p=0:nk=0", str(path)]
    end = None
    with tempfile.TemporaryFile(mode="w+") as errors:
        with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True) as process:
            try:
                for line in process.stdout:
                    fields = dict(part.split("=", 1) for part in line.strip().split("|") if "=" in part)
                    if "pts_time" not in fields:
                        continue
                    pts = number(fields["pts_time"], "packet.pts", float("-inf"))
                    duration = number(fields["duration_time"], "packet.duration", 0.000001)
                    end = max(end if end is not None else pts, pts + duration)
            except Exception:
                process.kill()
                raise
            if process.wait():
                errors.seek(0)
                raise ValueError(f"Cannot measure video duration: {errors.read()}")
    if end is None:
        raise ValueError("Cannot determine video end from packet timestamps")
    return number(end - stream_start(stream), "video.duration", 0.001)


def needs_preparation(info):
    v, a = info["video_start"], info["audio_start"]
    return max(abs(v), abs(a), abs(v - a)) > ORIGIN_TOLERANCE


def write_new_json(path, value):
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")


def prepare(video, out_dir, existing_asr=False):
    video, out_dir = Path(video).resolve(), Path(out_dir).resolve()
    if not video.is_file():
        raise ValueError(f"Source file does not exist: {video}")
    data = ffprobe(video)
    info = describe(data, require_aligned=False)
    normalize = needs_preparation(info)
    if normalize and existing_asr:
        raise ValueError("Existing ASR/project is bound to this source; normalization needs a new job and ASR")
    prepared = out_dir / "prepared.mp4"
    probe = out_dir / "video_info.json"
    record_path = out_dir / "preparation.json"
    log = out_dir / "prepare.log"
    for path in (prepared, probe, record_path, log):
        if path.exists() or path.is_symlink():
            raise ValueError(f"Refusing to overwrite: {path}")
    out_dir.mkdir(parents=True, exist_ok=True)
    record = {"path": str(video), "probe": str(probe), "normalized": normalize,
              "video_start": info["video_start"], "audio_start": info["audio_start"]}
    if normalize:
        vs, audio = source_streams(data)
        duration = video_duration(video, vs)
        delta = info["audio_start"] - info["video_start"]
        # Shift both streams by the SAME origin. first_pts trims negative audio
        # samples or inserts leading silence; async=0 never stretches speech.
        audio_filter = (f"aresample=async=0:first_pts=0,apad,"
                        f"atrim=end={duration:.9f}")
        with tempfile.TemporaryDirectory(prefix=".prepare-", dir=out_dir) as temporary:
            target = Path(temporary) / "prepared.mp4"
            command = ["ffmpeg", "-nostdin", "-hide_banner", "-v", "warning", "-xerror", "-n",
                       "-copyts", "-itsoffset", f"{-info['video_start']:.9f}", "-i", str(video),
                       "-map", f"0:{vs['index']}", "-map", f"0:{audio['index']}",
                       "-c:v", "copy", "-af", audio_filter, "-c:a", "aac", "-b:a", "192k",
                       "-map_chapters", "-1", "-avoid_negative_ts", "disabled", str(target)]
            with log.open("x", encoding="utf-8") as errors:
                result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=errors)
            warnings = log.read_text(encoding="utf-8").lower()
            if result.returncode or any(word in warnings for word in ("non-monoton", "non monoton", "invalid", "discontinu")):
                raise ValueError(f"Video preparation failed; inspect {log}. No re-encoding fallback.")
            after_data = ffprobe(target)
            after = describe(after_data)
            out_video, out_audio = source_streams(after_data)
            if needs_preparation(after):
                raise ValueError("Prepared streams do not start near zero")
            tolerance = max(1 / info["fps"], 1024 / number(out_audio["sample_rate"], "sample_rate", 1))
            for stream in (out_video, out_audio):
                if abs(number(stream["duration"], "prepared.duration", 0.001) - duration) > tolerance + 0.001:
                    raise ValueError("Prepared stream duration differs from video duration")
            # Container estimates of average FPS can change on remux (last-packet
            # duration rounding); frame count and duration are checked separately.
            for key in ("width", "height", "video_codec"):
                if after[key] != info[key]:
                    raise ValueError(f"Video changed during stream copy: {key}")
            if vs.get("nb_frames") not in (None, "N/A") and out_video.get("nb_frames") != vs["nb_frames"]:
                raise ValueError("Video frame count changed during stream copy")
            # Publish only verified media, atomically and without overwriting.
            os.link(target, prepared)
        record.update(path=str(prepared), original_path=str(video), normalization=str(record_path),
                      audio_trim_start=max(0, -delta), audio_pad_start=max(0, delta),
                      video_duration=duration)
        info = after
    write_new_json(probe, info)
    write_new_json(record_path, record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video")
    parser.add_argument("--out-dir", required=True, help="Per-source intermediate directory")
    parser.add_argument("--existing-asr", action="store_true", help="Refuse changes to an ASR/project-bound source")
    args = parser.parse_args()
    print(json.dumps(prepare(args.video, args.out_dir, args.existing_asr), ensure_ascii=False))


if __name__ == "__main__":
    main_guard(main)
