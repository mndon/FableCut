"""Offline behavioral tests. Fixtures are synthetic, never presented as real ASR."""
import copy
import json
import http.server
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))

from build_edit_ops import build, check_project_mapping
from build_sentences import build as transcribe_bridge
from common import read_json, write_json
from render_selection import render, render_index
from verify_output import verify
from editorial import findings, review_draft, validate_review
from selection_tools import bind_media, estimate, query


def apply_ops(project, ops):
    """Independent test double for the documented merge-safe CLI patch contract."""
    result = copy.deepcopy(project)
    for op in ops:
        if op["op"] == "setProject":
            result.update(op["set"])
        elif op["op"] == "removeClip":
            result["clips"] = [c for c in result["clips"] if c["id"] != op["id"]]
        elif op["op"] == "addClip":
            result["clips"].append(copy.deepcopy(op["clip"]))
        elif op["op"] == "updateClip":
            clip = next(c for c in result["clips"] if c["id"] == op["id"])
            for key, value in op["set"].items():
                if value is None:
                    clip.pop(key, None)
                elif key == "props":
                    clip.setdefault("props", {}).update(value)
                else:
                    clip[key] = copy.deepcopy(value)
        else:
            raise AssertionError(f"Unsupported documented operation: {op}")
    return result


def fixture():
    sentences = {"sentences": []}
    for index in range(8):
        source = "s1" if index < 4 else "s2"
        start = (index % 4) * 6.0
        words = [{"start": start + w, "end": start + w + 1,
                  "word": text, "punc": ""} for w, text in enumerate("衣服很舒服")]
        sentences["sentences"].append({"index": index, "source_id": source,
            "raw_sentence_index": index % 4, "start": start, "end": start + 5,
            "text": "衣服很舒服", "speaker": "说话人1", "speaker_id": source + ":0",
            "eligible": True, "words": words})
    selection = {"template": "内容策略", "keep_indices": list(range(8))}
    config = {"namespace": "test_cut", "product_id": "p1", "speed": 1.1, "target_duration": 36,
        "allowed_speakers": ["s1:0", "s2:0"],
        "groups": {"hook": [0, 1], "value": [2, 3, 4, 5], "close": [6, 7]}, "subtitles": False}
    sources = {"sources": [{"id": "s1", "media_id": "m1"}, {"id": "s2", "media_id": "m2"}]}
    project = {"name": "test", "revision": 4, "width": 320, "height": 180, "fps": 24,
        "media": [{"id": "m1", "kind": "video", "duration": 24, "src": "/test/one.mp4"},
                  {"id": "m2", "kind": "video", "duration": 24, "src": "/test/two.mp4"}], "clips": []}
    return sentences, selection, config, sources, project


def content_fixture():
    return {"products": [{"id": "p1", "label": "测试商品", "spans": [[0, 3], [4, 7]],
                          "evidence": "合成测试：两素材展示同款"}],
            "units": [[0, 1], [2], [3], [4], [5], [6, 7]]}


def reviewed(s, sel, cfg, content):
    """Synthetic reviewer input for offline engineering tests, not an auto-approver."""
    review = review_draft(s, sel, cfg, content)
    for check in review["checks"]:
        check.update(indices=sel["keep_indices"], status="pass", evidence="合成审核依据")
    for issue in review["issues"]:
        issue.update(status="dismissed", resolution="合成测试的重复占位文本")
    return review


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def source(self, sid="s1", words=True):
        raw = {"rich_result": {"duration": 5000, "sentences": [
            {"begin_time": 1000, "end_time": 3000, "text": "面料，舒服。", "channel_id": 0,
             "words": [{"begin_time": 1000, "end_time": 1900, "word": "面料", "punc": "，"},
                       {"begin_time": 2100, "end_time": 3000, "word": "舒服", "punc": "。"}] if words else []}]},
             "speaker_mapping": {"0": "说话人1"}}
        path = self.root / (sid + ".json")
        write_json(path, raw)
        return {"id": sid, "path": str(self.root / (sid + ".mp4")), "transcript": str(path)}

    def test_exact_timestamps_no_raw_mutation_and_source_scoped_speakers(self):
        one, two = self.source(), self.source("s2")
        before = Path(one["transcript"]).read_bytes()
        data, summary = transcribe_bridge({"sources": [one, two]})
        self.assertEqual([s["index"] for s in data["sentences"]], [0, 1, 2, 3])
        self.assertEqual(data["sentences"][0]["end"], 1.9)
        self.assertEqual(data["sentences"][1]["start"], 2.1)
        self.assertEqual({s["speaker_id"] for s in summary["speakers"]}, {"s1:0", "s2:0"})
        self.assertEqual(before, Path(one["transcript"]).read_bytes())

    def test_another_device_downloads_project_asr_and_builds_identical_indices(self):
        source = self.source()
        raw = read_json(source["transcript"])
        for word in raw["rich_result"]["sentences"][0]["words"]:
            word["channel_id"] = 0
        write_json(source["transcript"], raw)
        expected = transcribe_bridge({"sources": [source]})
        body = Path(source["transcript"]).read_bytes()
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        project = {"media": [{"id": "m1", "asrUrl": f"http://127.0.0.1:{server.server_port}/asr.json"}]}
        other = self.root / "other-device" / "audio.json"
        result = subprocess.run([sys.executable, str(SKILL.parent / "tik-audio-asr/scripts/download_result.py"),
                                 project["media"][0]["asrUrl"], "--output", str(other)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(other.read_bytes(), body)
        self.assertEqual(requests, [None])
        source.update(transcript=str(other), asr_url=project["media"][0]["asrUrl"])
        self.assertEqual(transcribe_bridge({"sources": [source]}), expected)

    def test_binding_requires_matching_asr_url_when_recorded(self):
        for actual in (None, "https://example.com/wrong.json", "https://example.com/s1.json"):
            source = {"id": "s1", "asr_url": "https://example.com/s1.json"}
            imported = {"ok": True, "media": {"id": "m1", "kind": "video", "asrUrl": actual}}
            if actual == source["asr_url"]:
                self.assertEqual(bind_media({"sources": [source]}, "s1", imported)["sources"][0]["media_id"], "m1")
            else:
                with self.assertRaisesRegex(ValueError, "ASR URL"):
                    bind_media({"sources": [source]}, "s1", imported)
                self.assertNotIn("media_id", source)

    def test_missing_words_preserves_whole_sentence(self):
        data, _ = transcribe_bridge({"sources": [self.source(words=False)]})
        self.assertEqual(len(data["sentences"]), 1)
        self.assertEqual(data["sentences"][0]["start"], 1)
        self.assertEqual(data["sentences"][0]["end"], 3)
        self.assertEqual(data["sentences"][0]["words"], [])

    def test_invalid_word_timestamps_do_not_create_fake_fragments(self):
        source = self.source()
        raw = read_json(source["transcript"])
        raw["rich_result"]["sentences"][0]["words"][0]["end_time"] = 1000
        write_json(source["transcript"], raw)
        data, _ = transcribe_bridge({"sources": [source]})
        self.assertEqual(len(data["sentences"]), 1)
        self.assertEqual(data["sentences"][0]["words"], [])

    def test_range_retains_global_indices(self):
        one, two = self.source(), self.source("s2")
        one["range"] = [2, 4]
        data, _ = transcribe_bridge({"sources": [one, two]})
        self.assertEqual([s["index"] for s in data["sentences"]], [0, 1, 2, 3])
        self.assertEqual([s["eligible"] for s in data["sentences"]], [False, True, True, True])
        self.assertIn("范围外", render_index(data))

    def test_empty_or_reversed_asr_fails(self):
        source = self.source()
        raw = read_json(source["transcript"])
        raw["rich_result"]["sentences"] = []
        write_json(source["transcript"], raw)
        with self.assertRaises(ValueError):
            transcribe_bridge({"sources": [source]})

    def test_isolated_skill_runs_with_declared_dependencies(self):
        isolated = self.root / "skills" / "tik-video-semantic-slicer"
        shutil.copytree(SKILL, isolated, ignore=shutil.ignore_patterns("__pycache__"))
        for dependency in ("tik-audio-asr", "tik-edit-video"):
            shutil.copytree(SKILL.parent / dependency, isolated.parent / dependency,
                            ignore=shutil.ignore_patterns("__pycache__"))
        self.assertEqual({p.name for p in isolated.parent.iterdir()},
                         {isolated.name, "tik-audio-asr", "tik-edit-video"})
        one = self.source()
        sources_file = self.root / "sources.json"
        write_json(sources_file, {"sources": [one]})
        out = self.root / "run"
        command = [sys.executable, str(isolated / "scripts/build_sentences.py"),
                   "--sources", str(sources_file), "--out", str(out)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already exists", result.stderr)


class EditTests(unittest.TestCase):
    def setUp(self):
        self.s, self.sel, self.cfg, self.sources, self.project = fixture()
        self.content = content_fixture()

    def build(self, previous=None):
        return build(self.s, self.sel, self.cfg, self.sources, self.project, "test-project", previous,
                     self.content, reviewed(self.s, self.sel, self.cfg, self.content))

    def test_multi_source_speed_and_project_backed_display(self):
        ops, mapping = self.build()
        project = apply_ops(self.project, ops)
        self.assertAlmostEqual(mapping["duration"], 40 / 1.1)
        self.assertEqual(project["media"], self.project["media"])
        self.assertEqual(project["clips"][4]["mediaId"], "m2")
        self.assertEqual(project["clips"][4]["in"], 0)
        verify(project, mapping)
        text = render(self.s, self.cfg, self.sel, project=project, mapping=mapping, content=self.content)
        self.assertIn("已核对工程", text)
        self.assertIn("s2 0.000–5.000", text)
        self.assertIn("36.364", text)

    def test_asr_urls_follow_each_source_and_are_checked_after_submission(self):
        for source, media in zip(self.sources["sources"], self.project["media"]):
            source["asr_url"] = media["asrUrl"] = f"https://example.com/{source['id']}.json"
        ops, mapping = self.build()
        project = apply_ops(self.project, ops)
        verify(project, mapping)
        self.assertEqual({entry["source_id"]: entry["asr_url"] for entry in mapping["entries"]},
                         {s["id"]: s["asr_url"] for s in self.sources["sources"]})
        for value in (None, "https://example.com/wrong.json"):
            with self.subTest(value=value):
                project["media"][0]["asrUrl"] = value
                with self.assertRaisesRegex(ValueError, "ASR URL"):
                    verify(project, mapping)
        self.project["media"][0].pop("asrUrl")
        with self.assertRaisesRegex(ValueError, "ASR URL"):
            self.build()

    def test_speaker_filter_keeps_numbers_and_rejects_selected_exclusions(self):
        original = copy.deepcopy(self.s)
        self.cfg["allowed_speakers"] = ["s2:0"]
        with self.assertRaisesRegex(ValueError, "scope"):
            self.build()
        self.assertEqual(self.s, original)

    def test_bad_indices_and_groups(self):
        for indices in ([], [0, 0], [999], [1, 0, 2, 3, 4, 5, 6, 7]):
            with self.subTest(indices=indices):
                self.sel["keep_indices"] = indices
                with self.assertRaises(ValueError):
                    self.build()

    def test_media_bounds_speed_and_duration(self):
        self.project["media"][0]["duration"] = 2
        with self.assertRaisesRegex(ValueError, "exceeds"):
            self.build()
        self.project["media"][0]["duration"] = 24
        for speed in (0, 5, float("nan"), 4):
            self.cfg["speed"] = speed
            with self.assertRaises(ValueError):
                self.build()

    def test_refinement_updates_later_clips_and_subtitles(self):
        ops, previous = self.build()
        self.project = apply_ops(self.project, ops)
        old_start = self.project["clips"][4]["start"]
        self.cfg.update({"subtitles": True, "refinements": {"3": [[18, 20], [21, 23]]},
                         "subtitle_text": {"3:0": "衣服"}})
        ops, mapping = self.build(previous)
        actual = apply_ops(self.project, ops)
        verify(actual, mapping)
        videos = [e for e in mapping["entries"] if e["clip"]["kind"] == "video"]
        self.assertEqual(len(videos), 9)
        later = next(e["clip"] for e in videos if e["index"] == 4)
        self.assertAlmostEqual(later["start"], old_start - 1 / 1.1)
        subtitles = [e for e in mapping["entries"] if e["clip"]["kind"] == "text"]
        self.assertEqual(len(subtitles), 9)
        for v, t in zip(videos, subtitles):
            self.assertEqual(v["clip"]["start"], t["clip"]["start"])
            self.assertEqual(v["clip"]["duration"], t["clip"]["duration"])
        text = render(self.s, self.cfg, self.sel, project=actual, mapping=mapping, content=self.content)
        self.assertIn("衣服", text)
        rows = [line for line in text.splitlines() if line.startswith("| 3 |")]
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[0].endswith("衣服 |"))
        self.assertTrue(rows[1].endswith("舒服 |"))

    def test_refinement_requires_word_boundaries(self):
        self.cfg["refinements"] = {"3": [[18.1, 23]]}
        with self.assertRaisesRegex(ValueError, "exact ASR"):
            self.build()
        self.cfg["refinements"] = {"3": [[18, 23]]}
        self.s["sentences"][3]["words"] = []
        with self.assertRaisesRegex(ValueError, "reliable word"):
            self.build()

    def test_transition_geometry_and_subtitle_switches(self):
        self.cfg.update({"speed": 1, "subtitles": True, "transition": {"type": "fade", "duration": 0.3}})
        ops, mapping = self.build()
        project = apply_ops(self.project, ops)
        verify(project, mapping)
        self.assertAlmostEqual(mapping["duration"], 40 - 7 * 0.3)
        subs = [e["clip"] for e in mapping["entries"] if e["clip"]["kind"] == "text"]
        for left, right in zip(subs, subs[1:]):
            self.assertLessEqual(left["start"] + left["duration"], right["start"] + 1e-6)
        self.project = project
        self.cfg["transition"] = {"type": "none"}
        self.cfg["subtitles"] = False
        ops, next_mapping = self.build(mapping)
        actual = apply_ops(project, ops)
        self.assertTrue(all("transitionIn" not in c for c in actual["clips"]))
        self.assertTrue(all(c["kind"] == "video" for c in actual["clips"]))
        verify(actual, next_mapping)

    def test_external_edits_and_unrelated_clips_are_preserved(self):
        self.project["clips"] = [{"id": "unrelated", "kind": "text", "mediaId": None,
            "track": "V3", "start": 0, "in": 0, "duration": 2, "props": {"text": "用户标题"}}]
        ops, mapping = self.build()
        actual = apply_ops(self.project, ops)
        self.assertEqual(actual["clips"][0], self.project["clips"][0])
        self.project = actual
        managed = next(c for c in actual["clips"] if c["id"] != "unrelated")
        managed["duration"] += 0.1
        with self.assertRaisesRegex(ValueError, "timing mismatch"):
            self.build(mapping)

    def test_id_collision_refuses_without_previous_mapping(self):
        ops, _ = self.build()
        self.project = apply_ops(self.project, ops)
        with self.assertRaisesRegex(ValueError, "not owned"):
            self.build()

    def test_export_accepts_h264_profile_and_level_variants(self):
        ops, mapping = self.build()
        project = apply_ops(self.project, ops)
        data = {"format": {"duration": mapping["duration"]}, "streams": [
            {"codec_type": "video", "codec_name": "h264", "width": 320, "height": 180,
             "profile": "Main", "level": 51, "duration": mapping["duration"]},
            {"codec_type": "audio", "duration": mapping["duration"]}]}
        with patch("verify_output.ffprobe", return_value=data):
            verify(project, mapping, "synthetic.mp4")
            data["streams"][1]["duration"] += 1
            with self.assertRaisesRegex(ValueError, "stream durations"):
                verify(project, mapping, "synthetic.mp4")

    def test_unknown_speed_candidate_is_explicit(self):
        text = render(self.s, hook=[0, 1])
        self.assertIn("倍速待定", text)
        self.assertNotIn("1.1x", text)

    def test_cli_media_without_duration_uses_real_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "probe.json"
            write_json(path, {"duration": 24})
            for media, source in zip(self.project["media"], self.sources["sources"]):
                del media["duration"]
                source["probe"] = str(path)
            ops, mapping = self.build()
            actual = apply_ops(self.project, ops)
            verify(actual, mapping)
            self.assertEqual(mapping["entries"][0]["source_duration"], 24)
            self.assertNotIn("duration", actual["media"][0])
            actual["media"][0]["src"] = "/changed.mp4"
            with self.assertRaisesRegex(ValueError, "source changed"):
                verify(actual, mapping)


if __name__ == "__main__":
    unittest.main()
