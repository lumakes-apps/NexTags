import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient

with tempfile.TemporaryDirectory() as initial_dir, patch.dict(os.environ, {
    "SQLITE_DB_PATH": str(Path(initial_dir) / "initial.db"),
}):
    from app.dependencies import database
    from app.router import config
    from app.router import integrations as integrations_router
    from app import integrations
    from app.integrations.navidrome_integration import REFRESH_EVENTS, plan_sync
    from app.services import secret_store

KEY = Fernet.generate_key().decode()


class DatabaseTestCase(unittest.TestCase):
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
        env = patch.dict(os.environ, {"NEXTAGS_SECRET_KEY": KEY})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("ANTHROPIC_TOKEN", None)


class SecretStoreTests(DatabaseTestCase):
    def test_round_trip_stores_only_ciphertext(self):
        secret_store.set_secret("navidrome.password", "hunter2")
        self.assertEqual(secret_store.get_secret("navidrome.password"), "hunter2")
        self.assertEqual(secret_store.secret_source("navidrome.password"), "database")
        raw = sqlite3.connect(self.db.db_path).execute("SELECT ciphertext FROM Secrets").fetchone()[0]
        self.assertNotIn("hunter2", raw)

    def test_missing_or_changed_master_key(self):
        secret_store.set_secret("navidrome.password", "hunter2")
        with patch.dict(os.environ, {"NEXTAGS_SECRET_KEY": Fernet.generate_key().decode()}):
            self.assertIsNone(secret_store.get_secret("navidrome.password"))  # 換了主金鑰就解不開
        with patch.dict(os.environ, {"NEXTAGS_SECRET_KEY": ""}):
            self.assertFalse(secret_store.master_key_configured())
            with self.assertRaises(secret_store.SecretStoreError):
                secret_store.set_secret("navidrome.password", "x")

    def test_environment_variable_overrides_database(self):
        secret_store.set_secret("ai_lyrics.api_key", "from-db")
        with patch.dict(os.environ, {"ANTHROPIC_TOKEN": "from-env"}):
            self.assertEqual(secret_store.get_secret("ai_lyrics.api_key"), "from-env")
            self.assertEqual(secret_store.secret_source("ai_lyrics.api_key"), "env")
        self.assertEqual(secret_store.get_secret("ai_lyrics.api_key"), "from-db")


class IntegrationApiTests(DatabaseTestCase):
    def setUp(self):
        super().setUp()
        app = FastAPI(redirect_slashes=False)
        app.include_router(integrations_router.router, prefix="/api")
        app.include_router(config.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_secrets_are_write_only(self):
        response = self.client.put("/api/integrations/navidrome", json={
            "settings": {"base_url": "http://navidrome:4533", "username": "me"},
            "secrets": {"password": "hunter2"},
        })
        self.assertEqual(response.status_code, 200, response.text)
        for body in (response.text, self.client.get("/api/integrations").text, self.client.get("/api/config").text):
            self.assertNotIn("hunter2", body)
        navidrome = next(i for i in self.client.get("/api/integrations").json() if i["key"] == "navidrome")
        self.assertEqual(navidrome["secrets"], {"password": "database"})
        self.assertEqual(navidrome["settings"]["username"], "me")
        # null 清除密鑰
        self.client.put("/api/integrations/navidrome", json={"secrets": {"password": None}})
        self.assertIsNone(secret_store.get_secret("navidrome.password"))

    def test_unknown_fields_are_rejected(self):
        self.assertEqual(self.client.put("/api/integrations/navidrome", json={"settings": {"nope": 1}}).status_code, 400)
        self.assertEqual(self.client.put("/api/integrations/navidrome", json={"settings": {"password": "x"}}).status_code, 400)
        self.assertEqual(self.client.put("/api/integrations/missing", json={}).status_code, 404)

    def test_ai_lyrics_unavailable_without_key(self):
        ai = next(i for i in self.client.get("/api/integrations").json() if i["key"] == "ai_lyrics")
        self.assertTrue(ai["enabled"])
        self.assertFalse(ai["available"])
        with self.assertRaises(ValueError):
            integrations.ai_lyrics.api_key()
        with patch.dict(os.environ, {"ANTHROPIC_TOKEN": "k"}):
            self.assertEqual(integrations.ai_lyrics.api_key(), "k")


class EventDispatchTests(DatabaseTestCase):
    def test_refresh_events_reach_the_hook_only_when_enabled(self):
        with patch("app.integrations.navidrome_integration.request_navidrome_refresh") as hook:
            for event in REFRESH_EVENTS:
                integrations.emit_event(event, {"x": 1})
            integrations.emit_event("tags_saved", {"file_path": "/Music/a.flac"})
            self.assertEqual(sorted(call.args[0] for call in hook.call_args_list), sorted(REFRESH_EVENTS))

            hook.reset_mock()
            integrations.navidrome.save(settings={"refresh_hook": False})
            integrations.emit_event("audio_cover_update", {})
            hook.assert_not_called()

            integrations.navidrome.save(enabled=False, settings={"refresh_hook": True})
            integrations.emit_event("audio_cover_update", {})
            hook.assert_not_called()

    def test_wait_for_scan_follows_settings(self):
        self.assertTrue(integrations.navidrome.wait_for_scan())
        integrations.navidrome.save(settings={"wait_for_scan": False})
        self.assertFalse(integrations.navidrome.wait_for_scan())
        integrations.navidrome.save(enabled=False, settings={"wait_for_scan": True})
        self.assertFalse(integrations.navidrome.wait_for_scan())


class PlanSyncTests(unittest.TestCase):
    U = {"a", "b", "c", "d"}

    def test_initial_strategies(self):
        local, remote = {"a", "b"}, {"b", "c"}
        union = plan_sync(local, remote, self.U, None, "union")
        self.assertEqual((union["star"], union["favorite"], union["final"]), ({"a"}, {"c"}, {"a", "b", "c"}))
        keep_local = plan_sync(local, remote, self.U, None, "local")
        self.assertEqual((keep_local["star"], keep_local["unstar"], keep_local["favorite"]), ({"a"}, {"c"}, set()))
        keep_remote = plan_sync(local, remote, self.U, None, "remote")
        self.assertEqual((keep_remote["favorite"], keep_remote["unfavorite"], keep_remote["star"]), ({"c"}, {"a"}, set()))

    def test_incremental_follows_the_side_that_changed(self):
        snapshot = {"a", "b"}
        # NexTags 取消了 a、Navidrome 新增了 c：各自傳到另一邊
        plan = plan_sync({"b"}, {"a", "b", "c"}, self.U, snapshot)
        self.assertEqual(plan["unstar"], {"a"})
        self.assertEqual(plan["favorite"], {"c"})
        self.assertEqual(plan["final"], {"b", "c"})

    def test_songs_missing_on_one_side_are_left_alone(self):
        plan = plan_sync({"a", "x"}, {"a"}, {"a"}, {"a"})
        self.assertEqual(plan["star"], set())
        self.assertEqual(plan["final"], {"a"})


if __name__ == "__main__":
    unittest.main()
