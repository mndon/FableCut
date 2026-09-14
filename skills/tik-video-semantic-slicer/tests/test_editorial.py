"""Offline regressions for editorial boundaries and the local CLI contracts."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_pipeline import (SKILL, apply_ops, build, content_fixture, estimate, findings,
                           fixture, query, render, reviewed, review_draft, validate_review)
from selection_tools import bind_media


class EditorialTests(unittest.TestCase):
    def setUp(self):
        self.s, self.sel, self.cfg, self.sources, self.project = fixture()
        self.content = content_fixture()

    def data(self):
        return self.s, self.sel, self.cfg, self.content

    def build(self, review=None):
        return build(self.s, self.sel, self.cfg, self.sources, self.project, "test",
                     content=self.content, review=review or reviewed(*self.data()))

    def test_black_hook_white_close_is_rejected(self):
        self.content["products"][0]["spans"] = [[0, 3]]
        self.content["products"].append({"id": "p2", "label": "白色另一款", "spans": [[4, 7]],
                                         "evidence": "主播说明当前仅白色，黑色是前款"})
        with self.assertRaisesRegex(ValueError, "Cross-product"):
            self.build()
        with self.assertRaisesRegex(ValueError, "Cross-product"):
            render(self.s, config=self.cfg, hook=[6, 7], content=self.content)

    def test_product_spans_cannot_overlap_or_cross_sources(self):
        for spans in ([[0, 4]], [[0, 3], [3, 3]]):
            self.content["products"][0]["spans"] = spans
            with self.assertRaises(ValueError):
                self.build()

    def test_partial_unit_and_unit_across_modules_are_rejected(self):
        self.sel["keep_indices"].remove(1)
        self.cfg["groups"]["hook"] = [0]
        with self.assertRaisesRegex(ValueError, "Partial semantic"):
            self.build()
        self.cfg["groups"]["value"].insert(0, 1)
        self.sel["keep_indices"].insert(1, 1)
        with self.assertRaisesRegex(ValueError, "Partial semantic"):
            self.build()

    def test_many_phrases_count_as_one_unit_without_rewriting_timestamps(self):
        self.cfg["groups"] = {"hook": [0, 1, 2, 3], "value": [4, 5], "close": [6, 7]}
        self.content["units"] = [[0, 1, 2, 3], [4, 5], [6, 7]]
        before = copy.deepcopy(self.s)
        _, mapping = self.build()
        self.assertEqual(len(mapping["entries"]), 8)
        self.assertEqual(self.s, before)
        self.assertEqual(estimate(*self.data())["units"], {"hook": 1, "value": 1, "close": 1})

    def test_review_is_required_and_draft_is_never_approval(self):
        with self.assertRaisesRegex(ValueError, "Missing/stale"):
            build(self.s, self.sel, self.cfg, self.sources, self.project, "test", content=self.content)
        with self.assertRaisesRegex(ValueError, "Incomplete editorial"):
            self.build(review_draft(*self.data()))

    def test_review_invalidated_by_config_content_and_text(self):
        review = reviewed(*self.data())
        for obj, key, value in ((self.cfg, "speed", 1.2), (self.content["products"][0], "evidence", "不同依据"),
                                (self.s["sentences"][0], "text", "已变更")):
            old = obj[key]
            obj[key] = value
            with self.assertRaisesRegex(ValueError, "stale"):
                validate_review(*self.data(), review)
            obj[key] = old

    def test_wording_risks_cannot_be_silently_omitted(self):
        self.s["sentences"][2]["text"] = "所以像这个真的不需要去纠结"
        self.s["sentences"][3]["text"] = "不用纠结"
        self.s["sentences"][4]["text"] = "搭外套也可以可以的"
        flags = findings(self.s, self.sel)
        self.assertTrue(any(f["indices"] == [2, 3] for f in flags))
        self.assertTrue(any(f["indices"] == [4] for f in flags))
        review = reviewed(*self.data())
        review["issues"] = []
        with self.assertRaisesRegex(ValueError, "omits"):
            validate_review(*self.data(), review)
        review = reviewed(*self.data())
        review["issues"][0]["status"] = "pending"
        with self.assertRaisesRegex(ValueError, "Unresolved"):
            validate_review(*self.data(), review)

    def test_unavailable_media_needs_reason_and_is_not_pass(self):
        review = reviewed(*self.data())
        review["media"]["audio"] = {"status": "unavailable", "evidence": ""}
        with self.assertRaisesRegex(ValueError, "needs evidence"):
            validate_review(*self.data(), review)
        review["media"]["audio"]["evidence"] = "当前模型无音频输入"
        self.build(review)
        self.assertEqual(review["media"]["audio"]["status"], "unavailable")

    def test_final_display_rejects_stale_business_config(self):
        ops, mapping = self.build()
        self.cfg["product_id"] = "renamed"
        self.content["products"][0]["id"] = "renamed"
        with self.assertRaisesRegex(ValueError, "differs"):
            render(self.s, self.cfg, self.sel, project=apply_ops(self.project, ops), mapping=mapping, content=self.content)

    def test_hook_speaker_conflict(self):
        self.cfg["allowed_speakers"] = ["s2:0"]
        with self.assertRaisesRegex(ValueError, "speakers"):
            render(self.s, config=self.cfg, hook=[0, 1], content=self.content)

    def test_estimate_matches_geometry_with_refinement_and_transition(self):
        self.cfg.update(speed=1, refinements={"3": [[18, 20], [21, 23]]},
                        transition={"type": "fade", "duration": 0.3})
        _, mapping = self.build()
        timing = estimate(*self.data())
        self.assertAlmostEqual(timing["duration"], mapping["duration"], places=3)
        self.assertAlmostEqual(sum(timing["modules"].values()), timing["duration"], places=3)
        self.cfg["speed"] = 4
        self.cfg["transition"] = {"type": "none"}
        self.assertFalse(estimate(*self.data())["in_range"])

    def test_query_preserves_ids_and_bounds_context_to_source(self):
        result = query(self.s, [3], context=2)
        self.assertEqual([r["index"] for r in result], [1, 2, 3])
        self.assertNotIn("words", result[-1])
        self.assertEqual(query(self.s, [3], words=True)[0]["words"], self.s["sentences"][3]["words"])
        with self.assertRaises(ValueError):
            query(self.s, [999])

    def test_binding_preserves_sources_and_rejects_conflict(self):
        imported = {"ok": True, "media": {"id": "m1", "kind": "video"}}
        before = copy.deepcopy(self.sources)
        self.assertEqual(bind_media(self.sources, "s1", imported), before)
        imported["media"]["id"] = "other"
        with self.assertRaisesRegex(ValueError, "another media"):
            bind_media(self.sources, "s1", imported)
        self.assertEqual(self.sources, before)

    def test_cli_handles_paths_with_spaces_and_no_project(self):
        with tempfile.TemporaryDirectory(prefix="slice test ") as root:
            for name, data in zip(("sentences", "selection", "config", "content"), self.data()):
                Path(root, name + ".json").write_text(json.dumps(data), encoding="utf-8")
            args = [sys.executable, "-B", str(SKILL / "scripts/selection_tools.py"), "estimate"]
            for name in ("sentences", "selection", "config", "content"):
                args += ["--" + name, str(Path(root, name + ".json"))]
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["in_range"])

    def test_environment_check_never_emits_values(self):
        path = SKILL.parent / "tik-audio-asr/scripts/check_environment.py"
        spec = importlib.util.spec_from_file_location("check_environment", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with patch.dict(os.environ, {"TIK_API_KEY": "synthetic-secret", "FABLECUT_TOKEN": "synthetic-token"}):
            result = module.check()
            self.assertEqual(result["TIK_API_KEY"], "configured")
            self.assertNotIn("synthetic", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
