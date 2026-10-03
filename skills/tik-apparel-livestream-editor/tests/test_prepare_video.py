"""Offline media tests: timestamp alignment, decoded samples and copied frames."""
import array
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from common import ffprobe
from prepare_video import needs_preparation, prepare, video_duration
from probe_video import describe, inspect
from build_sentences import build as build_sentences


def run(*args):
    return subprocess.run(args, check=True, capture_output=True).stdout


class OriginTests(unittest.TestCase):
    def test_thresholds_and_negative_origins(self):
        for v, a, expected in [(0, 0, False), (0.02, 0.1, False),
                               (-0.09, 0.09, True), (1.515, 1.515, True),
                               (1.515, 0.02, True), (0.02, 1.515, True)]:
            self.assertEqual(needs_preparation({"video_start": v, "audio_start": a}), expected)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requires ffmpeg/ffprobe")
class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.base = self.root / "base.mp4"
        run("ffmpeg", "-v", "error", "-f", "lavfi", "-i",
            "testsrc2=s=96x64:r=25:d=4", "-vf",
            "drawbox=x=0:y=0:w=20:h=20:color=white:t=fill:enable='between(t,2,2.08)'",
            "-c:v", "libx264", "-bf", "2", "-video_track_timescale", "1000000", str(self.base))

    def source(self, name, v=0, a=0, audio_duration=4):
        # A pulse at video-relative 2s remains aligned to the visible marker.
        # Extra early audio makes incorrect start trimming observable.
        delta = a - v
        pulses = [2 - delta]
        if delta < -0.1:
            pulses.append(0.2)
        samples = array.array("h", (int(16000 * math.sin(2 * math.pi * 1000 * n / 48000))
                                    if any(p <= n / 48000 < p + 0.08 for p in pulses) else 0
                                    for n in range(round(audio_duration * 48000))))
        if sys.byteorder != "little":
            samples.byteswap()
        audio = self.root / (name + ".wav")
        with wave.open(str(audio), "wb") as handle:
            handle.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
            handle.writeframes(samples.tobytes())
        source = self.root / (name + ".mov")
        run("ffmpeg", "-v", "error", "-copyts", "-itsoffset", str(v), "-i", str(self.base),
            "-itsoffset", str(a), "-i", str(audio), "-map", "0:v:0", "-map", "1:a:0",
            "-c", "copy", "-video_track_timescale", "1000000", "-avoid_negative_ts", "disabled", str(source))
        return source

    def frames(self, path):
        result = run("ffmpeg", "-v", "error", "-copyts", "-i", str(path), "-map", "0:v:0",
                     "-fps_mode", "passthrough", "-f", "framemd5", "-").decode()
        return [line.split(",") for line in result.splitlines() if line and not line.startswith("#")]

    def pcm(self, path):
        data = array.array("f")
        data.frombytes(run("ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1",
                           "-ar", "48000", "-f", "f32le", "-"))
        if sys.byteorder != "little":
            data.byteswap()
        return data

    def check_alignment(self, source, record):
        target = Path(record["path"])
        before, after = self.frames(source), self.frames(target)
        self.assertEqual(len(before), 100)
        self.assertEqual([r[-1] for r in before], [r[-1] for r in after])
        # Relative presentation times and decoded picture content both survive.
        self.assertEqual([int(r[2]) - int(before[0][2]) for r in before],
                         [int(r[2]) - int(after[0][2]) for r in after])
        pcm = self.pcm(target)
        active = [i / 48000 for i, sample in enumerate(pcm) if abs(sample) > 0.05]
        self.assertTrue(active)
        self.assertAlmostEqual(min(active), 2, delta=0.04)
        self.assertAlmostEqual(max(active), 2.08, delta=0.04)
        self.assertAlmostEqual(len(pcm) / 48000, 4, delta=1024 / 48000)
        self.assertFalse(needs_preparation(inspect(target)))
        mp3 = target.parent / "extracted.mp3"
        run("ffmpeg", "-v", "error", "-i", str(target), "-map", "0:a:0", "-vn", "-ac", "1",
            "-ar", "16000", "-c:a", "libmp3lame", "-q:a", "4", str(mp3))
        inspect(target, mp3)

    def test_early_late_and_common_nonzero_origins(self):
        for name, v, a in [("early", 1.515, 0.020), ("late", 0.020, 1.515),
                            ("common", 1.515, 1.515)]:
            with self.subTest(name=name):
                source = self.source(name, v, a, audio_duration=6)
                original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
                record = prepare(source, self.root / name)
                self.check_alignment(source, record)
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original_hash)
                self.assertEqual(record["original_path"], str(source))
                self.assertAlmostEqual(record["audio_trim_start"], max(0, v - a), places=3)
                self.assertAlmostEqual(record["audio_pad_start"], max(0, a - v), places=3)

    def test_short_audio_pads_tail(self):
        source = self.source("short", 0.020, 1.515, audio_duration=1)
        self.check_alignment(source, prepare(source, self.root / "short"))

    def test_aac_input_preserves_alignment_with_encoder_delay(self):
        for name, v, a in [("early", 1.515, 0.020), ("late", 0.020, 1.515)]:
            with self.subTest(name=name):
                source = self.source(name, v, a, audio_duration=6)
                aac = self.root / (name + ".mp4")
                run("ffmpeg", "-v", "error", "-copyts", "-i", str(source), "-c:v", "copy",
                    "-c:a", "aac", "-avoid_negative_ts", "disabled", str(aac))
                self.check_alignment(aac, prepare(aac, self.root / (name + "-prepared")))

    def test_normal_source_is_reused_and_outputs_never_overwritten(self):
        source = self.source("normal")
        destination = self.root / "normal"
        record = prepare(source, destination, existing_asr=True)
        self.assertEqual(record["path"], str(source))
        self.assertFalse(record["normalized"])
        self.assertFalse((destination / "prepared.mp4").exists())
        before = (destination / "preparation.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "overwrite"):
            prepare(source, destination)
        self.assertEqual(before, (destination / "preparation.json").read_bytes())

    def test_existing_asr_and_failed_process_publish_no_source(self):
        source = self.source("late", 0.020, 1.515)
        with self.assertRaisesRegex(ValueError, "Existing ASR"):
            prepare(source, self.root / "bound", existing_asr=True)
        self.assertFalse((self.root / "bound").exists())
        destination = self.root / "failed"
        # Only intercept encoding; ffprobe still reads the real source.
        real_run = subprocess.run
        def fail_encoding(command, **kwargs):
            if command[0] == "ffmpeg":
                return subprocess.CompletedProcess(command, 1)
            return real_run(command, **kwargs)
        with patch("prepare_video.subprocess.run", side_effect=fail_encoding):
            with self.assertRaisesRegex(ValueError, "preparation failed"):
                prepare(source, destination)
        self.assertTrue((destination / "prepare.log").exists())
        self.assertFalse((destination / "prepared.mp4").exists())
        self.assertFalse((destination / "preparation.json").exists())

    def test_failed_verification_does_not_publish_media(self):
        source = self.source("late", 0.020, 1.515)
        destination = self.root / "failed"
        real_probe = ffprobe
        def wrong_origin(path):
            data = real_probe(path)
            if Path(path) != source:
                data["streams"][0]["start_time"] = "1.5"
            return data
        with patch("prepare_video.ffprobe", side_effect=wrong_origin):
            with self.assertRaisesRegex(ValueError, "time origins"):
                prepare(source, destination)
        self.assertFalse((destination / "prepared.mp4").exists())
        self.assertFalse((destination / "video_info.json").exists())
        self.assertFalse((destination / "preparation.json").exists())

    def test_packet_duration_fallback_and_unusable_origins(self):
        source = self.source("late", 0.020, 1.515)
        data = ffprobe(source)
        video = dict(data["streams"][0])
        video.pop("duration")
        self.assertAlmostEqual(video_duration(source, video), 4, places=3)
        for value in ("NaN", "N/A"):
            data["streams"][0]["start_time"] = value
            with self.assertRaises(ValueError):
                describe(data, require_aligned=False)
        del data["streams"][0]["start_time"]
        with self.assertRaises(KeyError):
            describe(data, require_aligned=False)

    def test_prepared_asr_timestamps_are_not_shifted_again(self):
        source = self.source("late", 0.020, 1.515)
        record = prepare(source, self.root / "late")
        transcript = self.root / "asr.json"
        transcript.write_text(json.dumps({"rich_result": {"duration": 4000, "sentences": [
            {"begin_time": 2000, "end_time": 2080, "text": "测试", "channel_id": 0}]},
            "channel": [0]}))
        sentences, _ = build_sentences({"sources": [{**record, "id": "s1", "transcript": str(transcript)}]})
        self.assertEqual(sentences["sentences"][0]["start"], 2)
        self.assertEqual(sentences["sentences"][0]["end"], 2.08)


if __name__ == "__main__":
    unittest.main()
