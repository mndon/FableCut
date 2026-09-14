"""Offline ASR contract tests; no paid API calls or real credentials."""
import contextlib
import copy
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import transcribe as asr
from download_result import download_result


RESULT = {"rich_result": {"duration": 1000, "sentences": [
    {"begin_time": 0, "end_time": 1000, "text": "你好。", "channel_id": 7,
     "words": [{"begin_time": 0, "end_time": 1000, "word": "你好", "punc": "。", "channel_id": 7}]}]},
    "speaker_mapping": {"7": "说话人1"}}
RESULT_URL = "https://example.com/result.json?sig=a%2Bb&x=1"


class TranscribeTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.detail = {"parse_status": 3, "rich_result": RESULT["rich_result"]}
        self.client = self.enterContext(patch.object(asr, "TikAiClient")).return_value
        self.client.api_request.side_effect = self.api_request
        self.enterContext(patch.object(asr, "load_config", return_value="synthetic-test-key"))
        self.enterContext(patch.object(asr, "read_metadata", return_value=asr.AudioMetadata(
            Path("/synthetic.wav"), 1.0, 100, ".wav", "synthetic-md5")))

    def api_request(self, path, method, payload=None):
        self.requests.append((path, method, payload))
        if path == "/api/v2/toolExtract":
            return {"Id": 1}
        if path.endswith("applyAudioUploadAddresses"):
            return {"exist": True, "urls": []}
        if method == "GET":
            return self.detail
        return {}

    def test_default_and_explicit_modes_ignore_legacy_environment(self):
        for mode in (None, 0, 1):
            with self.subTest(mode=mode), patch.dict(os.environ, {"TIK_AUDIO_ASR_RETURN_MODE": "1" if mode != 1 else "0"}):
                self.requests.clear()
                self.detail = {"parse_status": 3, **({"json_url": RESULT_URL} if mode == 1 else
                                                    {"rich_result": copy.deepcopy(RESULT["rich_result"])})}
                result = asr.transcribe("/synthetic.wav") if mode is None else asr.transcribe("/synthetic.wav", mode)
                self.assertEqual(self.requests[0][2]["return_mode"], mode or 0)
                self.assertEqual(result, {"json_url": RESULT_URL} if mode == 1 else RESULT)

    def test_url_mode_rejects_missing_or_invalid_url(self):
        for url in (None, "", "/result.json", "file:///tmp/a.json", "https://", "https://x:bad/a", 123):
            with self.subTest(url=url):
                self.detail = {"parse_status": 3, "json_url": url}
                with self.assertRaises(asr.ToolError) as error:
                    asr.transcribe("/synthetic.wav", 1)
                self.assertEqual(error.exception.code, "INVALID_RESPONSE")

    def test_main_emits_one_json_and_rejects_invalid_arguments_before_network(self):
        self.detail = {"parse_status": 3, "json_url": RESULT_URL}
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.assertEqual(asr.main(["transcribe", "/synthetic.wav", "--return-mode", "1"]), 0)
        self.assertEqual(json.loads(stdout.getvalue()), {"json_url": RESULT_URL})
        for suffix in (["--return-mode", "2"], ["--return-mode"], ["--return-mode", "abc"]):
            self.requests.clear()
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                asr.main(["transcribe", "/synthetic.wav", *suffix])
            self.assertEqual(error.exception.code, 2)
            self.assertEqual(self.requests, [])

    def test_no_speech_and_invalid_inline_result_remain_errors(self):
        for mode in (0, 1):
            self.detail = {"parse_status": 4}
            with self.assertRaises(asr.ToolError) as error:
                asr.transcribe("/synthetic.wav", mode)
            self.assertEqual(error.exception.code, "NO_SPEECH")
        self.detail = {"parse_status": 3, "json_url": RESULT_URL}
        with self.assertRaises(asr.ToolError):
            asr.transcribe("/synthetic.wav", 0)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "audio.json"

    def test_original_bytes_preserved_without_credentials_or_overwrite(self):
        raw = json.dumps(RESULT, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        with patch("download_result.urlopen", return_value=io.BytesIO(raw)) as request:
            result = download_result(RESULT_URL, self.output)
            request.assert_called_once_with(RESULT_URL, timeout=60)
        self.assertEqual(result["path"], str(self.output.resolve()))
        self.assertEqual(self.output.read_bytes(), raw)
        with patch("download_result.urlopen") as request, self.assertRaises(asr.ToolError):
            download_result(RESULT_URL, self.output)
        request.assert_not_called()
        self.assertEqual(self.output.read_bytes(), raw)

    def test_invalid_content_never_creates_transcript(self):
        for raw in (b"not json", b"[]", b'{"json_url":"https://example.com/a"}',
                    json.dumps({"rich_result": RESULT["rich_result"], "speaker_mapping": {}}).encode()):
            with self.subTest(raw=raw), patch("download_result.urlopen", return_value=io.BytesIO(raw)):
                with self.assertRaises(asr.ToolError):
                    download_result(RESULT_URL, self.output)
                self.assertFalse(self.output.exists())

    def test_expired_url_reports_download_failure_without_output(self):
        with patch("download_result.urlopen", side_effect=HTTPError(RESULT_URL, 403, "Expired", {}, None)):
            with self.assertRaises(asr.ToolError) as error:
                download_result(RESULT_URL, self.output)
        self.assertEqual(error.exception.code, "DOWNLOAD_FAILED")
        self.assertNotIn(RESULT_URL, error.exception.message)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
