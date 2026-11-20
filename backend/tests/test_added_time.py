import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from app.dependencies.mp3tag_writer import write_tags


def _free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


@unittest.skipUnless(shutil.which('redis-server') and shutil.which('ffmpeg'),
                     'Added time tests require redis-server and ffmpeg')
class AddedTimeOrderingTests(unittest.TestCase):
    """編輯標籤會改 mtime，但列表與播放清單排序必須維持加入時間。"""

    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        cls.server = subprocess.Popen(
            ['redis-server', '--port', str(cls.port), '--save', '', '--appendonly', 'no'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        with patch.dict(os.environ, {'REDIS_HOST': '127.0.0.1', 'REDIS_PORT': str(cls.port), 'REDIS_DB': '0'}):
            from app.dependencies.redis_cache import RedisCache
            for _ in range(50):
                try:
                    cls.cache = RedisCache()
                    break
                except Exception:
                    time.sleep(0.1)
            else:
                raise RuntimeError('redis-server did not start')

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait()

    def setUp(self):
        self.cache.client.flushdb()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.older = self.make_audio('older.flac', mtime=1_000_000)
        self.newer = self.make_audio('newer.flac', mtime=2_000_000)
        for path in (self.older, self.newer):
            self.cache.upsert_audio_record(path)

    def make_audio(self, name, mtime):
        path = str(Path(self.temp.name) / name)
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
                        '-t', '0.05', path], check=True, capture_output=True)
        os.utime(path, (mtime, mtime))
        return path

    def edit(self, path):
        self.assertTrue(write_tags(path, {'title': 'edited'}))
        self.assertGreater(os.path.getmtime(path), 2_000_000)
        self.cache.upsert_audio_record(path)

    def page_order(self):
        return [record['file_path'] for record in self.cache.get_audio_records_page(1, 10)['records']]

    def test_editing_keeps_added_time_and_page_order(self):
        self.assertEqual(self.page_order(), [self.newer, self.older])
        self.edit(self.older)
        record = json.loads(self.cache.client.get(self.cache._get_catalog_record_key(self.older)))
        self.assertEqual(record['added_time'], 1_000_000)
        self.assertGreater(record['modification_time'], 2_000_000)
        self.assertEqual(record['tags']['title'], 'edited')
        self.assertEqual(self.page_order(), [self.newer, self.older])

    def test_rebuild_and_clear_preserve_added_time(self):
        self.edit(self.older)
        self.cache.rebuild_cache([self.older, self.newer])
        self.assertEqual(self.page_order(), [self.newer, self.older])
        self.cache.clear_cache()
        self.cache.rebuild_cache([self.older, self.newer])
        self.assertEqual(self.page_order(), [self.newer, self.older])

    def test_legacy_catalog_is_backfilled_from_mtime(self):
        # 模擬升級前的 catalog：record 沒有 added_time、只有舊的 by_mtime 索引
        client = self.cache.client
        for path in (self.older, self.newer):
            key = self.cache._get_catalog_record_key(path)
            record = json.loads(client.get(key))
            record.pop('added_time')
            client.set(key, json.dumps(record))
        client.delete(self.cache.ADDED_TIME_HASH, self.cache.CATALOG_ADDED_ZSET)
        client.zadd(self.cache.LEGACY_MTIME_ZSET, {self.older: 1, self.newer: 2})

        self.assertEqual(self.page_order(), [self.newer, self.older])
        self.assertFalse(client.exists(self.cache.LEGACY_MTIME_ZSET))
        self.assertEqual(float(client.hget(self.cache.ADDED_TIME_HASH, self.older)), 1_000_000)

    def test_playlist_creation_time_sort_uses_added_time(self):
        from app.router.playlists import sort_songs_by_creation_time
        self.edit(self.older)
        metadata = {r['file_path']: r for r in self.cache.get_audio_records()}
        self.assertEqual(sort_songs_by_creation_time([self.older, self.newer], metadata),
                         [self.newer, self.older])


if __name__ == '__main__':
    unittest.main()
