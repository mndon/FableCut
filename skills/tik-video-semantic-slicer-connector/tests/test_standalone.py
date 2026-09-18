"""Check the three-skill client installation without the server slicer."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ClientPackageTests(unittest.TestCase):
    def test_local_links_only_require_declared_client_skills(self):
        allowed = [ROOT, ROOT.parent / "tik-audio-asr", ROOT.parent / "tik-edit-video"]
        for path in ROOT.rglob("*.md"):
            for link in re.findall(r"\]\(([^)]+)\)", path.read_text()):
                if "://" in link or link.startswith("#"):
                    continue
                target = (path.parent / link.split("#", 1)[0]).resolve()
                with self.subTest(document=path.name, link=link):
                    self.assertTrue(any(target.is_relative_to(root) for root in allowed),
                                    f"Undeclared client skill dependency: {link}")
                    self.assertTrue(target.is_file(), f"Missing packaged resource: {link}")

    def test_client_installation_works_without_server_slicer(self):
        with tempfile.TemporaryDirectory() as temp:
            installed = Path(temp) / ROOT.name
            shutil.copytree(ROOT, installed, ignore=shutil.ignore_patterns("__pycache__", "tests"))
            for name in ("tik-audio-asr", "tik-edit-video"):
                shutil.copytree(ROOT.parent / name, Path(temp) / name,
                                ignore=shutil.ignore_patterns("__pycache__", "tests"))
            environment = dict(os.environ, PYTHONPATH="", PYTHONDONTWRITEBYTECODE="1")
            for script in ("prepare_video.py", "probe_video.py", "exchange.py", "create_session.py"):
                with self.subTest(script=script):
                    result = subprocess.run([sys.executable, str(installed / "scripts" / script), "--help"],
                                            cwd=temp, env=environment, text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((Path(temp) / "tik-video-semantic-slicer").exists())
            for script in ("transcribe.py", "download_result.py"):
                result = subprocess.run([sys.executable, str(Path(temp) / "tik-audio-asr/scripts" / script), "--help"],
                                        cwd=temp, env=environment, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
