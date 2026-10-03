from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import exchange
import create_session


class ExchangeTests(unittest.TestCase):
    def setUp(self):
        self.base = {"name": "服装准备", "width": 1080, "height": 1920, "fps": 30, "revision": 4,
                     "media": [{"id": "m1", "kind": "video", "name": "准备.mp4", "duration": 120,
                                "src": "/projects/client/media/prepared.mp4", "asrUrl": "https://example.com/asr.json"}],
                     "clips": []}
        self.bindings = {"sources": [{"id": "s1", "media_id": "m1", "sha256": "a" * 64,
                                      "remote_src": "https://example.com/prepared.mp4", "range": [0, 100]}]}
        self.outbound, self.request, self.state = exchange.export_project(self.base, self.bindings,
                                                                         {"speed": 1.1}, "client", "run_1")
        self.returned = deepcopy(self.outbound)
        self.returned["revision"] = 92
        self.returned["media"][0]["src"] = "/projects/server/media/prepared.mp4"
        self.returned["clips"] = [{"id": "c1", "kind": "video", "mediaId": "m1", "track": "V1",
                                   "start": 0, "in": 3, "duration": 40, "props": {"speed": 1.1}}]
        self.result = self.seal()

    def seal(self):
        return exchange.seal_result(self.request, self.returned, {"geometry": "passed", "audiovisual": "pending"})

    def receive(self, current=None):
        return exchange.receive_project(self.state, current or self.base, self.returned, self.result, "client")

    def test_round_trip_restores_local_sources_and_client_revision(self):
        restored = self.receive()
        self.assertEqual(restored["media"], self.base["media"])
        self.assertEqual(restored["revision"], 4)
        self.assertEqual(restored["clips"], self.returned["clips"])
        self.assertEqual(self.returned["revision"], 92)
        self.assertNotIn("client_project_id", self.request)
        self.assertNotIn("/projects/client/", json.dumps(self.outbound))

    def test_concurrent_revision_and_content_changes_are_rejected(self):
        for field, value in (("revision", 5), ("name", "手工修改")):
            changed = deepcopy(self.base)
            changed[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "CONFLICT"):
                self.receive(changed)

    def test_wrong_run_and_input_are_rejected(self):
        for key in ("run_id", "input_project_sha256", "project_sha256", "status"):
            result = deepcopy(self.result)
            result[key] = "wrong"
            with self.subTest(key=key), self.assertRaises(ValueError):
                exchange.receive_project(self.state, self.base, self.returned, result, "client")

    def test_reordered_media_restored_by_id(self):
        second = deepcopy(self.base["media"][0])
        second.update(id="m2", src="/projects/client/media/two.mp4")
        base = deepcopy(self.base)
        base["media"].append(second)
        bindings = deepcopy(self.bindings)
        binding = deepcopy(bindings["sources"][0])
        binding.update(id="s2", media_id="m2")
        bindings["sources"].append(binding)
        exported, request, state = exchange.export_project(base, bindings, {}, "client", "run_2")
        exported["media"].reverse()
        exported["clips"] = self.returned["clips"]
        receipt = exchange.seal_result(request, exported, {"geometry": "passed", "audiovisual": "pending"})
        restored = exchange.receive_project(state, base, exported, receipt, "client")
        self.assertEqual(restored["media"], base["media"])

    def test_rebound_asr_and_unknown_media_rejected(self):
        self.returned["media"][0]["asrUrl"] = "https://example.com/wrong.json"
        self.result = self.seal()
        with self.assertRaisesRegex(ValueError, "ASR binding"):
            self.receive()
        self.returned["media"][0]["id"] = "cloud_id"
        self.returned["clips"][0]["mediaId"] = "cloud_id"
        self.result = self.seal()
        with self.assertRaisesRegex(ValueError, "media IDs"):
            self.receive()

    def test_out_of_bounds_and_speed_keyframes_rejected(self):
        for changes in ({"in": 119}, {"keyframes": {"speed": [{"t": 0, "v": 2}]}}):
            project = deepcopy(self.returned)
            project["clips"][0].update(changes)
            with self.assertRaises(ValueError):
                exchange.validate_project(project)

    def test_bad_duration_or_empty_timeline_not_completed(self):
        for clips in ([], [{**self.returned["clips"][0], "duration": 10}]):
            self.returned["clips"] = clips
            self.result = self.seal()
            with self.assertRaises(ValueError):
                self.receive()

    def test_local_urls_and_mount_traversal_rejected(self):
        for src in ("/Users/me/video.mp4", "http://localhost:7777/a", "http://127.0.0.1/a",
                    "http://192.168.1.1/a", "https://user:pass@example.com/a", "/mnt/session/uploads/../secret"):
            self.bindings["sources"][0]["remote_src"] = src
            with self.subTest(src=src), self.assertRaises(ValueError):
                exchange.export_project(self.base, self.bindings, {}, "client", "run_1")

    def test_mount_path_is_supported(self):
        self.bindings["sources"][0]["remote_src"] = "/mnt/session/uploads/input/prepared.mp4"
        out, _, _ = exchange.export_project(self.base, self.bindings, {}, "client", "run_1")
        self.assertTrue(out["media"][0]["src"].startswith("/mnt/session/uploads/"))

    def test_missing_binding_bad_range_and_nan_rejected(self):
        for binding in ({"sources": []}, {"sources": [{**self.bindings["sources"][0], "range": [0, 200]}]}):
            with self.assertRaises(ValueError):
                exchange.export_project(self.base, binding, {}, "client", "run_1")
        self.returned["clips"][0]["duration"] = float("nan")
        with self.assertRaises(ValueError):
            exchange.validate_project(self.returned)

    def test_cli_export_receive_and_no_overwrite(self):
        script = Path(exchange.__file__)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, value in (("base", self.base), ("bindings", self.bindings), ("requirements", {}),
                                ("returned", self.returned), ("result", self.result)):
                exchange.write_new(root / (name + ".json"), value)
            export = [sys.executable, str(script), "export", "--project", str(root / "base.json"),
                      "--bindings", str(root / "bindings.json"), "--requirements", str(root / "requirements.json"),
                      "--project-id", "client", "--run-id", "run_1", "--out-dir", str(root / "out")]
            self.assertEqual(subprocess.run(export, capture_output=True).returncode, 0)
            self.assertNotEqual(subprocess.run(export, capture_output=True).returncode, 0)
            receive = [sys.executable, str(script), "receive", "--state", str(root / "out/client-state.json"),
                       "--current", str(root / "base.json"), "--project", str(root / "returned.json"),
                       "--result", str(root / "result.json"), "--project-id", "client", "--output", str(root / "local.json")]
            self.assertEqual(subprocess.run(receive, capture_output=True).returncode, 0)
            self.assertEqual(exchange.read(root / "local.json")["media"], self.base["media"])
            self.assertNotEqual(subprocess.run(receive, capture_output=True).returncode, 0)


class SessionTests(unittest.TestCase):
    def payload(self):
        return {"agent": "agent_abc", "environment_id": "env_abc", "title": "切片",
                "resources": [{"type": "file", "file_id": "file_abc", "mount_path": "/uploads/input/project.json"}]}

    def test_invalid_resources_rejected_before_network(self):
        payload = self.payload()
        payload["resources"][0]["mount_path"] = "/workspace/project.json"
        with self.assertRaises(ValueError):
            create_session.validate_payload(payload)

    def test_session_response_secrets_not_saved_or_in_argv(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {}, clear=True):
            root = Path(temp)
            config = root / "config.json"
            exchange.write_new(config, {"api_key": "test-secret", "base_url": "https://workspace.cn-beijing.maas.aliyuncs.com"})
            response = {"id": "sesn_abc", "status": "idle", "environment_variables": {"SECRET": "remote-secret"}}
            with patch.object(create_session.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(response), "")) as run:
                create_session.create(self.payload(), config, root / "session.json")
                self.assertNotIn("test-secret", repr(run.call_args.args))
                self.assertIn("test-secret", run.call_args.kwargs["input"])
                record = (root / "session.json").read_text()
                self.assertNotIn("secret", record)
                self.assertEqual(json.loads(record)["session_id"], "sesn_abc")

    def test_uncertain_create_does_not_retry(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {}, clear=True):
            root = Path(temp)
            config = root / "config.json"
            exchange.write_new(config, {"api_key": "test", "base_url": "https://workspace.cn-beijing.maas.aliyuncs.com"})
            with patch.object(create_session.subprocess, "run", return_value=subprocess.CompletedProcess([], 28, "", "timeout")) as run:
                with self.assertRaises(ValueError):
                    create_session.create(self.payload(), config, root / "session.json")
                with self.assertRaises(FileExistsError):
                    create_session.create(self.payload(), config, root / "session.json")
                self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
