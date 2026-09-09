"""Verify actual FableCut geometry and optionally its exported MP4."""
import argparse
from fractions import Fraction

from build_edit_ops import check_project_mapping
from common import EPS, ffprobe, main_guard, number, project_duration, read_json


def verify(project, mapping, video=None):
    check_project_mapping(project, mapping)
    duration = project_duration(project)
    if abs(duration - mapping["duration"]) > 0.001 or not 35 - EPS <= duration <= 90 + EPS:
        raise ValueError("Project duration differs from the cut or is outside 35–90s")
    if project.get("inPoint", 0) not in (None, 0) or project.get("outPoint") not in (None, 0, duration):
        raise ValueError("Project in/out points may restrict export; reconcile explicitly")
    if video:
        data = ffprobe(video)
        actual = number(data["format"]["duration"], "export.duration")
        vs = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
        audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
        if not vs or not audio:
            raise ValueError("Export must contain both video and audio streams")
        if abs(actual - duration) > 1:
            raise ValueError(f"Export duration differs by >1s ({actual:.3f} vs {duration:.3f})")
        if vs["width"] != project["width"] or vs["height"] != project["height"]:
            raise ValueError("Export dimensions differ from the project")
        if vs.get("avg_frame_rate") not in (None, "0/0"):
            fps = float(Fraction(vs["avg_frame_rate"]))
            if abs(fps - number(project["fps"], "project.fps", 1)) > 0.1:
                raise ValueError("Export FPS differs from the project")
        if vs["codec_name"] != "h264":
            raise ValueError("Expected CLI MP4 export with H.264 video")
        if vs.get("duration") and audio.get("duration"):
            if abs(float(vs["duration"]) - float(audio["duration"])) > 0.2:
                raise ValueError("Audio/video stream durations differ by >0.2s; review synchronization")
    return duration


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="Fresh native project JSON from CLI")
    parser.add_argument("--mapping", required=True)
    parser.add_argument("--video", help="Optional exported MP4")
    args = parser.parse_args()
    duration = verify(read_json(args.project), read_json(args.mapping), args.video)
    print(f"[通过] Project/cut geometry verified: {duration:.3f}s" + ("; MP4 streams/duration verified" if args.video else ""))


if __name__ == "__main__":
    main_guard(main)
