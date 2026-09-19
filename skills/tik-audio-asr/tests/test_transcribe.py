"""Offline ASR contract tests; no paid API calls or real credentials."""
import contextlib
import copy
import io
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import ANY, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import transcribe as asr
from download_result import download_result, download_ssl_context


RESULT = {"rich_result": {"duration": 1000, "sentences": [
    {"begin_time": 0, "end_time": 1000, "text": "你好。", "channel_id": 7,
     "words": [{"begin_time": 0, "end_time": 1000, "word": "你好", "punc": "。", "channel_id": 7}]}]},
    "channel": [7]}
RESULT_URL = "https://example.com/result.json?sig=a%2Bb&x=1"


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_missing_ffprobe_reports_dependency(self):
        path = self.root / "audio.mp3"
        path.write_bytes(b"audio")
        with patch.object(asr.subprocess, "run", side_effect=FileNotFoundError):
            with self.assertRaises(asr.ToolError) as error:
                asr.read_metadata(str(path))
        self.assertEqual(error.exception.code, "DEPENDENCY_MISSING")

    def test_invalid_probe_duration_is_rejected(self):
        path = self.root / "audio.mp3"
        path.write_bytes(b"audio")
        for duration in ("NaN", "inf", "0", "-1", "N/A"):
            response = subprocess.CompletedProcess([], 0, json.dumps({
                "streams": [{"codec_type": "audio"}], "format": {"duration": duration}}))
            with self.subTest(duration=duration), patch.object(asr.subprocess, "run", return_value=response):
                with self.assertRaises(asr.ToolError) as error:
                    asr.read_metadata(str(path))
                self.assertEqual(error.exception.code, "AUDIO_METADATA_INVALID")

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requires ffmpeg and ffprobe")
    def test_real_video_extraction_and_mp3_duration(self):
        video = self.root / "video with spaces.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                        "color=size=16x16:rate=10", "-f", "lavfi", "-i",
                        "sine=frequency=440:sample_rate=16000", "-t", "2",
                        "-c:v", "mpeg4", "-c:a", "aac", str(video)], check=True)
        audio = self.root / "audio.mp3"
        asr.extract_audio(video, audio)
        self.assertAlmostEqual(asr.read_metadata(str(audio)).duration_seconds, 2, delta=0.2)
        self.assertTrue(video.exists())

    def test_video_temp_cleanup_on_success_and_failure(self):
        video = self.root / "video.MP4"
        video.write_bytes(b"synthetic video")
        for fail in (False, True):
            extracted = []
            def extract(source, target):
                self.assertEqual(source, video)
                target.write_bytes(b"synthetic audio")
                extracted.append(target)
            def transcribe(path):
                self.assertTrue(Path(path).is_file())
                if fail:
                    raise asr.ToolError("API_FAILED", "synthetic error")
                return {"json_url": RESULT_URL}
            with self.subTest(fail=fail), patch.object(asr, "load_config", return_value="synthetic-key"), \
                    patch.object(asr, "extract_audio", side_effect=extract), \
                    patch.object(asr, "transcribe_audio", side_effect=transcribe):
                if fail:
                    with self.assertRaises(asr.ToolError):
                        asr.transcribe(str(video))
                else:
                    self.assertEqual(asr.transcribe(str(video)), {"json_url": RESULT_URL})
            self.assertFalse(extracted[0].parent.exists())
            self.assertEqual(video.read_bytes(), b"synthetic video")

    def test_extraction_errors_do_not_start_transcription(self):
        video = self.root / "video.mp4"
        video.write_bytes(b"invalid video")
        for exc, code in ((FileNotFoundError(), "DEPENDENCY_MISSING"),
                          (subprocess.CalledProcessError(1, "ffmpeg"), "AUDIO_EXTRACTION_FAILED")):
            with self.subTest(code=code), patch.object(asr, "load_config", return_value="synthetic-key"), \
                    patch.object(asr.subprocess, "run", side_effect=exc), \
                    patch.object(asr, "transcribe_audio") as transcribe:
                with self.assertRaises(asr.ToolError) as error:
                    asr.transcribe(str(video))
                self.assertEqual(error.exception.code, code)
                transcribe.assert_not_called()


class TranscribeTests(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.requests = []
        self.detail = {"parse_status": 3, **copy.deepcopy(RESULT)}
        self.client = stack.enter_context(patch.object(asr, "TikAiClient")).return_value
        self.client.api_request.side_effect = self.api_request
        stack.enter_context(patch.object(asr, "load_config", return_value="synthetic-test-key"))
        stack.enter_context(patch.object(asr, "read_metadata", return_value=asr.AudioMetadata(
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

    def test_editor_request_uses_integer_and_returns_url(self):
        for detail in ({"parse_status": 3, "result_url": RESULT_URL},
                       {"id": 1, "parse_status": 3, "result_url": RESULT_URL, "title": "synthetic.wav"}):
            with self.subTest(detail=detail), patch.dict(os.environ, {"TIK_AUDIO_ASR_RETURN_MODE": "0"}):
                self.requests.clear()
                self.detail = detail
                self.assertEqual(asr.transcribe("/synthetic.wav"), {"json_url": RESULT_URL})
                self.assertNotIn("for_editor", self.requests[0][2])
                self.assertTrue(self.requests[0][2]["without_merge_word"])
                payload = next(body for path, method, body in self.requests if path.endswith("/audioTask"))
                self.assertTrue(payload["split"])
                self.assertEqual(payload["for_editor"], 1)
                self.assertIs(type(payload["for_editor"]), int)
                self.assertNotIn("return_mode", payload)

    def test_invalid_url_and_unexpected_detail_fail(self):
        for detail in ({}, RESULT, {"rich_result": None, "channel": []},
                       *({"parse_status": 3, "result_url": url} for url in (None, "", "/result.json", "file:///tmp/a", "https://", 123)),
                       {"parse_status": 3}, {"parse_status": 3, "json_url": RESULT_URL},
                       {"result_url": RESULT_URL}, {"parse_status": 0}, {"parse_status": True}):
            with self.subTest(detail=detail):
                self.detail = detail
                with self.assertRaises(asr.ToolError) as error:
                    asr.transcribe("/synthetic.wav")
                self.assertEqual(error.exception.code, "INVALID_RESPONSE")

    def test_processing_response_polls_until_url_result(self):
        for detail in ({"parse_status": 1, "result_url": ""}, {"parse_status": 2, "result_url": ""}):
            with self.subTest(detail=detail):
                self.detail = detail
                def complete(_):
                    self.detail = {"parse_status": 3, "result_url": RESULT_URL}
                with patch.object(asr.time, "sleep", side_effect=complete) as sleep:
                    self.assertEqual(asr.transcribe("/synthetic.wav"), {"json_url": RESULT_URL})
                sleep.assert_called_once_with(asr.POLL_INTERVAL_SECONDS)

    def test_explicit_failure_and_timeout(self):
        self.detail = {"parse_status": 4, "result_url": ""}
        with self.assertRaises(asr.ToolError) as error:
            asr.transcribe("/synthetic.wav")
        self.assertEqual(error.exception.code, "TRANSCRIPTION_FAILED")
        for detail in ({"parse_status": 1, "result_url": ""}, {"parse_status": 2, "result_url": ""}):
            with self.subTest(detail=detail):
                self.detail = detail
                with patch.object(asr.time, "monotonic", side_effect=[0, 0, asr.TIMEOUT_SECONDS]), \
                        patch.object(asr.time, "sleep"):
                    with self.assertRaises(asr.ToolError) as error:
                        asr.transcribe("/synthetic.wav")
                self.assertEqual(error.exception.code, "TIMEOUT")

    def test_main_emits_url_and_rejects_removed_option(self):
        self.detail = {"parse_status": 3, "result_url": RESULT_URL}
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.assertEqual(asr.main(["transcribe", "/synthetic.wav"]), 0)
        self.assertEqual(json.loads(stdout.getvalue()), {"json_url": RESULT_URL})
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)
        self.requests.clear()
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            asr.main(["transcribe", "/synthetic.wav", "--return-mode", "1"])
        self.assertEqual(self.requests, [])


class EditorResultTests(unittest.TestCase):
    def test_channels_and_null_preserved(self):
        result = copy.deepcopy(RESULT)
        result["rich_result"]["sentences"][0]["words"][0]["channel_id"] = 2
        result["channel"] = [7, 2]
        for payload in (result, {"rich_result": None, "channel": []}):
            before = copy.deepcopy(payload)
            self.assertEqual(asr.validate_editor_result(payload), before)
            self.assertEqual(payload, before)

    def test_channel_need_not_include_word_only_speaker(self):
        result = copy.deepcopy(RESULT)
        result["rich_result"]["sentences"][0]["words"][0]["channel_id"] = 2
        self.assertEqual(asr.validate_editor_result(result), result)

    def test_invalid_channels_and_legacy_result_rejected(self):
        for channels in (None, {}, [True], ["7"], [7, 7], []):
            with self.subTest(channels=channels), self.assertRaises(asr.ToolError):
                asr.validate_editor_result({**RESULT, "channel": channels})
        with self.assertRaises(asr.ToolError):
            asr.validate_editor_result({"rich_result": RESULT["rich_result"], "speaker_mapping": {"7": "说话人1"}})
        result = copy.deepcopy(RESULT)
        result["rich_result"]["sentences"][0]["channel_id"] = 2
        with self.assertRaises(asr.ToolError):
            asr.validate_editor_result(result)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "audio.json"

    def test_original_bytes_preserved_without_credentials_or_overwrite(self):
        raw = json.dumps(RESULT, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        with patch("download_result.urlopen", return_value=io.BytesIO(raw)) as request:
            result = download_result(RESULT_URL, self.output)
            request.assert_called_once_with(RESULT_URL, timeout=60, context=ANY)
            context = request.call_args.kwargs["context"]
            self.assertEqual(context.verify_mode, ssl.CERT_NONE)
            self.assertFalse(context.check_hostname)
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

    def test_download_preserves_null_and_unsorted_channels(self):
        result = copy.deepcopy(RESULT)
        result["rich_result"]["sentences"][0]["words"][0]["channel_id"] = 2
        result["channel"] = [7, 2]
        for index, payload in enumerate((result, {"rich_result": None, "channel": []})):
            raw = json.dumps(payload, indent=2).encode() + b"\n"
            target = self.output.with_name(f"result-{index}.json")
            with patch("download_result.urlopen", return_value=io.BytesIO(raw)):
                download_result(RESULT_URL, target)
            self.assertEqual(target.read_bytes(), raw)

    def test_expired_url_reports_download_failure_without_output(self):
        with patch("download_result.urlopen", side_effect=HTTPError(RESULT_URL, 403, "Expired", {}, None)):
            with self.assertRaises(asr.ToolError) as error:
                download_result(RESULT_URL, self.output)
        self.assertEqual(error.exception.code, "DOWNLOAD_FAILED")
        self.assertNotIn(RESULT_URL, error.exception.message)
        self.assertFalse(self.output.exists())

    def test_download_disables_verification_with_ca_environment(self):
        for variable in ("SSL_CERT_FILE", "SSL_CERT_DIR"):
            with self.subTest(variable=variable), \
                    patch.dict(os.environ, {variable: "/custom/ca"}, clear=True):
                context = download_ssl_context()
                self.assertEqual(context.verify_mode, ssl.CERT_NONE)
                self.assertFalse(context.check_hostname)


if __name__ == "__main__":
    unittest.main()
