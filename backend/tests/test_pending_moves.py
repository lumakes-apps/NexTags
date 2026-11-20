import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from app.services import pending_moves


def _free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


@unittest.skipUnless(shutil.which('redis-server') and shutil.which('ffmpeg'),
                     'Pending move tests require redis-server and ffmpeg')
class PendingMoveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        cls.server = subprocess.Popen(['redis-server', '--port', str(cls.port), '--save', '', '--appendonly', 'no'],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with patch.dict(os.environ, {'REDIS_HOST': '127.0.0.1', 'REDIS_PORT': str(cls.port), 'REDIS_DB': '0'}):
            from app.dependencies.redis_cache import RedisCache
            for _ in range(50):
                try:
                    cls.cache = RedisCache()
                    break
                except Exception:
                    time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait()

    def setUp(self):
        self.cache.client.flushdb()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.status_file = self.root / 'status' / 'status.json'
        self.refreshes = []
        for patcher in (
            patch.object(pending_moves, 'redis_cache', self.cache),
            patch.object(pending_moves, 'STATUS_FILE', str(self.status_file)),
            patch.object(pending_moves, 'request_navidrome_refresh', lambda reason, payload=None: self.refreshes.append(reason)),
            patch('app.router.playlists.regenerate_all_m3u', lambda: True),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.album = self.root / 'B 人聲/Music/Artist/Old Album'
        self.source = self.album / '01 - Song.flac'
        self.album.mkdir(parents=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.05',
                        str(self.source)], check=True, capture_output=True)
        (self.album / 'cover.jpg').write_bytes(b'cover')
        os.utime(self.source, (1_000_000, 1_000_000))
        self.cache.upsert_audio_record(str(self.source))
        self.target = self.root / 'B 人聲/Music/Artist/New Album/01 - Song.flac'

    def write_status(self, requested_at, ok=True):
        self.status_file.parent.mkdir(parents=True, exist_ok=True)
        self.status_file.write_text(json.dumps({'ok': ok, 'request_requested_at': requested_at.isoformat(),
                                                'completed_at': datetime.now(timezone.utc).isoformat()}))

    def test_waits_for_a_scan_requested_after_the_tag_write(self):
        entry = pending_moves.queue_move(str(self.source), str(self.target))
        self.assertEqual(self.refreshes, ['pending_move'])
        self.assertEqual(pending_moves.process_pending_moves(), 0)  # 尚無狀態檔
        created = datetime.fromisoformat(entry['created_at'])
        self.write_status(created - timedelta(seconds=5))  # 寫入前就發出的掃描，不算
        self.assertEqual(pending_moves.process_pending_moves(), 0)
        self.write_status(created + timedelta(seconds=1), ok=False)  # 掃描失敗，不算
        self.assertEqual(pending_moves.process_pending_moves(), 0)
        self.assertTrue(self.source.exists())

        self.write_status(created + timedelta(seconds=1))
        self.assertEqual(pending_moves.process_pending_moves(), 1)
        self.assertTrue(self.target.exists())
        self.assertFalse(self.source.exists())
        self.assertEqual(pending_moves.list_moves(), [])
        self.assertEqual(self.refreshes[-1], 'pending_moves_done')

    def test_move_keeps_added_time_and_carries_leftovers(self):
        pending_moves.perform_move(str(self.source), str(self.target))
        client = self.cache.client
        self.assertEqual(float(client.hget(self.cache.ADDED_TIME_HASH, str(self.target))), 1_000_000)
        self.assertIsNone(client.hget(self.cache.ADDED_TIME_HASH, str(self.source)))
        self.assertTrue(client.sismember(self.cache.CATALOG_PATHS_KEY, str(self.target)))
        self.assertFalse(client.sismember(self.cache.CATALOG_PATHS_KEY, str(self.source)))
        # 舊專輯資料夾已沒有音檔：cover.jpg 帶到新資料夾、舊資料夾移除
        self.assertEqual((self.target.parent / 'cover.jpg').read_bytes(), b'cover')
        self.assertFalse(self.album.exists())

    def test_folder_with_other_songs_is_left_in_place(self):
        shutil.copy(self.source, self.album / '02 - Other.flac')
        pending_moves.perform_move(str(self.source), str(self.target))
        self.assertTrue((self.album / 'cover.jpg').exists())
        self.assertFalse((self.target.parent / 'cover.jpg').exists())

    def test_existing_target_is_never_overwritten(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b'keep me')
        entry = pending_moves.queue_move(str(self.source), str(self.target))
        self.write_status(datetime.fromisoformat(entry['created_at']) + timedelta(seconds=1))
        self.assertEqual(pending_moves.process_pending_moves(), 0)
        self.assertEqual(self.target.read_bytes(), b'keep me')
        self.assertTrue(self.source.exists())
        failed = pending_moves.get_move(str(self.source))
        self.assertEqual(failed['status'], 'failed')
        self.assertIn('目標位置已有檔案', failed['error'])

    def test_requeue_replaces_target_and_waits_again(self):
        first = pending_moves.queue_move(str(self.source), str(self.root / 'x.flac'))
        time.sleep(0.01)
        second = pending_moves.queue_move(str(self.source), str(self.target))
        self.write_status(datetime.fromisoformat(first['created_at']) + timedelta(microseconds=1))
        self.assertEqual(pending_moves.process_pending_moves(), 0)  # 第二次寫入之後還沒掃描
        self.assertEqual(pending_moves.get_move(str(self.source))['target'], str(self.target))
        self.write_status(datetime.fromisoformat(second['created_at']) + timedelta(seconds=1))
        self.assertEqual(pending_moves.process_pending_moves(), 1)


if __name__ == '__main__':
    unittest.main()
