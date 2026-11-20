import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

# 匯入既有全域 DB/client 時也使用測試設定，避免觸及正式 SQLite 或 API key。
with tempfile.TemporaryDirectory() as initial_dir, patch.dict(os.environ, {
    "SQLITE_DB_PATH": str(Path(initial_dir) / "initial.db"),
    "ANTHROPIC_TOKEN": "test-key",
    "ANTHROPIC_API_KEY": "test-key",
}):
    from app.dependencies import database, lrc_process
    from app.router import config, prompts, tools
    from app.schemas.prompts import MAX_LYRIC_LENGTH, MAX_PROMPT_LENGTH, PromptUpdate
    from app.services import prompt_service


class LyricsPromptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.db = database.Database.__new__(database.Database)
        self.db.db_path = str(Path(self.directory.name) / "test.db")
        self.db._initialize_db()
        for module in (database, config):
            patcher = patch.object(module, "db", self.db)
            patcher.start()
            self.addCleanup(patcher.stop)
        config._config_cache_invalidate()
        prompt_service.initialize_lyrics_prompt()
        app = FastAPI(redirect_slashes=False)
        for router in (config.router, prompts.router, tools.router):
            app.include_router(router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def read(self):
        response = self.client.get("/api/prompts/lyrics")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def save(self, text, revision=1):
        return self.client.put("/api/prompts/lyrics", json={
            "text": text, "expected_revision": revision,
        })

    def test_default_is_byte_identical_to_original_python_literal(self):
        text = self.read()["text"]
        self.assertEqual(
            hashlib.sha256(text.encode()).hexdigest(),
            "11960e2af60ac388cf819bc6f768d3d7d9e310db25275cbccd7d597730f7db48",
        )
        self.assertEqual(text, self.read()["default_text"])

    def test_save_preserves_whitespace_and_survives_initialization(self):
        custom = "  請保留格式\n\n"
        response = self.save(custom)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["revision"], 2)
        self.assertEqual(response.json()["text"], custom)
        prompt_service.initialize_lyrics_prompt()
        self.db._initialize_db()
        self.assertEqual(self.read()["text"], custom)
        self.assertEqual(self.read()["revision"], 2)
        with self.db.get_connection() as conn:
            value = conn.execute("SELECT config_value FROM Config WHERE config_key = ?", (prompt_service.PROMPT_KEY,)).fetchone()[0]
        self.assertEqual(json.loads(value)["text"], custom)

    def test_stale_update_preserves_newer_value(self):
        self.assertEqual(self.save("新版").status_code, 200)
        self.assertEqual(self.save("舊頁面草稿").status_code, 409)
        self.assertEqual(self.read()["text"], "新版")

    def test_concurrent_writes_have_one_winner(self):
        def save(text):
            try:
                prompt_service.save_lyrics_prompt(PromptUpdate(text=text, expected_revision=1))
                return 200
            except HTTPException as error:
                return error.status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(save, ["草稿 A", "草稿 B"]))
        self.assertEqual(sorted(statuses), [200, 409])
        self.assertEqual(self.read()["revision"], 2)

    def test_validation_rejects_invalid_updates(self):
        for text in ("", " \n\t", "x" * (MAX_PROMPT_LENGTH + 1), 123, None):
            with self.subTest(text_type=type(text).__name__):
                self.assertEqual(self.save(text).status_code, 422)
        for revision in (0, -1, "1", True, None):
            self.assertEqual(self.save("草稿", revision).status_code, 422)
        self.assertEqual(self.read()["revision"], 1)

    def test_generic_config_api_cannot_bypass_prompt_validation(self):
        key = prompt_service.PROMPT_KEY
        payload = {"config_key": key, "config_value": "繞過版本檢查"}
        for url in ("/api/config", "/api/config/"):
            self.assertEqual(self.client.post(url, json=payload).status_code, 422)
        self.assertEqual(self.client.put(f"/api/config/{key}", json=payload).status_code, 422)
        self.assertEqual(self.client.delete(f"/api/config/{key}").status_code, 422)
        self.assertEqual(self.client.put("/api/config/another", json=payload).status_code, 422)
        with self.assertRaises(HTTPException):
            config.set_config(key, "繞過路由")
        self.assertEqual(self.read()["revision"], 1)
        normal = {"config_key": "supported_tags", "config_value": ["test"]}
        self.assertEqual(self.client.post("/api/config/", json=normal).status_code, 200)

    def test_generic_config_read_does_not_return_cached_prompt(self):
        key = prompt_service.PROMPT_KEY
        self.assertEqual(config.get_config(key)["revision"], 1)
        self.save("更新後內容")
        self.assertEqual(config.get_config(key)["text"], "更新後內容")

    def test_preview_uses_draft_and_does_not_persist(self):
        before = self.read()
        lyric = "[00:01.123]This is a sample"
        with patch.object(lrc_process, "call_anthropic_api", return_value="預覽結果") as call:
            response = self.client.post("/api/prompts/lyrics/preview", json={"text": "未儲存的草稿\n", "lyric": lyric})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"result": "預覽結果"})
        self.assertEqual(call.call_args.args[0], [
            {"role": "user", "content": "未儲存的草稿\n"},
            {"role": "user", "content": lyric},
        ])
        self.assertEqual(self.read(), before)

    def test_legacy_endpoint_uses_new_prompt_on_next_request(self):
        with patch.object(lrc_process, "call_anthropic_api", return_value="整理結果") as call:
            original = self.client.post("/api/tools/lyric", json={"lyric": "原歌詞"})
            self.assertEqual(original.json(), {"result": "整理結果"})
            self.assertEqual(call.call_args.args[0][0]["content"], self.read()["default_text"])
            self.save("請使用新規則")
            self.client.post("/api/tools/lyric", json={"lyric": "原歌詞"})
            self.assertEqual(call.call_args.args[0][0]["content"], "請使用新規則")

    def test_running_request_keeps_prompt_snapshot(self):
        original = self.read()["text"]
        def provider(messages):
            self.save("處理途中儲存的新規則")
            self.assertEqual(messages[0]["content"], original)
            return "原版本處理的結果"
        with patch.object(lrc_process, "call_anthropic_api", side_effect=provider):
            response = self.client.post("/api/tools/lyric", json={"lyric": "歌詞"})
        self.assertEqual(response.json()["result"], "原版本處理的結果")
        self.assertEqual(self.read()["revision"], 2)

    def test_failed_preview_keeps_formal_prompt(self):
        before = self.read()
        with patch.object(lrc_process, "call_anthropic_api", side_effect=RuntimeError("provider failed")):
            response = self.client.post("/api/prompts/lyrics/preview", json={"text": "草稿", "lyric": "歌詞"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.read(), before)

    def test_preview_validates_input_and_rejects_unknown_fields(self):
        for fields in ({"lyric": ""}, {"lyric": " \n"}, {"lyric": "x" * (MAX_LYRIC_LENGTH + 1)}, {"extra": True}):
            payload = {"text": "草稿", "lyric": "歌詞", **fields}
            self.assertEqual(self.client.post("/api/prompts/lyrics/preview", json=payload).status_code, 422)

    def test_truncated_response_is_not_applied(self):
        message = SimpleNamespace(stop_reason="max_tokens", content=[SimpleNamespace(text="不完整歌詞")])
        with patch.object(lrc_process.client.messages, "create", return_value=message):
            response = self.client.post("/api/tools/lyric", json={"lyric": "原歌詞"})
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("result", response.json())


if __name__ == "__main__":
    unittest.main()
