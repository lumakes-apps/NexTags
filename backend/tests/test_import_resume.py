"""匯入進度存在 Redis：重啟後仍可接續；進度遺失的暫存檔可重新開始處理。"""
import io
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.datastructures import UploadFile

from app.dependencies import redis_cache as redis_cache_module
from app.router import music_import
from app.schemas.music_import import ImportStatus, ResumeImportRequest
from app.services import import_sessions as store_module
from app.services.import_sessions import ImportSessionStore

UUID = '12345678-1234-1234-1234-123456789abc'


def _free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def _fake_validate(base_folder):
    if base_folder not in ('B 人聲', 'A 純音樂'):
        raise HTTPException(status_code=400, detail=f"不支援的目標資料夾: {base_folder}")


@unittest.skipUnless(shutil.which('redis-server'), 'Import resume tests require redis-server')
class ImportResumeTests(unittest.IsolatedAsyncioTestCase):
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
        self.wait_import = self.root / 'WaitImport'
        self.wait_import.mkdir()
        for patcher in (
            patch.object(redis_cache_module, 'redis_cache', self.cache),
            patch.object(music_import, 'get_music_base_path', return_value=str(self.root)),
            patch.object(music_import, 'validate_base_folder', _fake_validate),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def restart(self):
        """模擬 backend 重啟：換一個新的 store（記憶體清空），只剩 Redis 裡的資料。"""
        fresh = ImportSessionStore()
        for patcher in (patch.object(store_module, 'import_sessions', fresh),
                        patch.object(music_import, 'import_sessions', fresh)):
            patcher.start()
            self.addCleanup(patcher.stop)
        return fresh

    def temp_file(self, name: str) -> Path:
        path = self.wait_import / name
        path.write_bytes(b'audio')
        return path

    # ---- 儲存 ----

    def test_sessions_survive_a_restart_and_finished_ones_expire(self):
        path = self.temp_file(f'{UUID}_song.flac')
        music_import.update_import_status(UUID, ImportStatus.TAGS_EDITED, temp_path=str(path), base_folder='B 人聲',
                                          original_filename='song.flac', extracted_tags={'artist': 'A', 'album': 'B'})
        store = self.restart()
        session = store[UUID]
        self.assertEqual(session['status'], ImportStatus.TAGS_EDITED)
        self.assertEqual(session['extracted_tags'], {'artist': 'A', 'album': 'B'})
        self.assertEqual(self.cache.client.ttl(store_module.KEY_PREFIX + UUID), -1)  # 未完成的不會過期

        music_import.update_import_status(UUID, ImportStatus.COMPLETED)
        self.assertGreater(self.cache.client.ttl(store_module.KEY_PREFIX + UUID), 0)
        self.cache.client.delete(store_module.KEY_PREFIX + UUID)  # 模擬過期
        self.assertEqual(store.all(), {})
        self.assertFalse(self.cache.client.sismember(store_module.INDEX_KEY, UUID))

    def test_reads_are_copies_and_errors_persist(self):
        music_import.update_import_status(UUID, ImportStatus.UPLOADED, temp_path='x')
        music_import.import_sessions[UUID]['status'] = 'failed'  # 改副本不影響儲存
        self.assertEqual(music_import.import_sessions[UUID]['status'], 'uploaded')
        music_import.add_import_error(UUID, '轉換失敗: boom')
        self.assertEqual(self.restart()[UUID]['errors'], ['轉換失敗: boom'])

    # ---- 接續 ----

    async def test_resume_existing_session_returns_the_next_step(self):
        path = self.temp_file(f'{UUID}_song.flac')
        music_import.update_import_status(UUID, ImportStatus.TAGS_EDITED, temp_path=str(path), base_folder='B 人聲',
                                          original_filename='song.flac')
        self.restart()
        result = await music_import.resume_import(ResumeImportRequest(file_id=UUID))
        self.assertFalse(result.recovered)
        self.assertEqual(result.status, ImportStatus.TAGS_EDITED)
        self.assertEqual(result.next_action, 'check-artist')

    async def test_lost_session_is_rebuilt_from_the_file_with_a_base_folder(self):
        path = self.temp_file(f'{UUID}_歌.m4a')
        with self.assertRaises(HTTPException) as missing:
            await music_import.resume_import(ResumeImportRequest(file_id=UUID))
        self.assertEqual(missing.exception.status_code, 400)
        with self.assertRaises(HTTPException):
            await music_import.resume_import(ResumeImportRequest(file_id=UUID, base_folder='Nope'))

        result = await music_import.resume_import(ResumeImportRequest(file_id=UUID, base_folder='B 人聲'))
        self.assertTrue(result.recovered)
        self.assertEqual(result.file_id, UUID)
        self.assertEqual(result.status, ImportStatus.UPLOADED)
        self.assertEqual(result.next_action, 'convert')  # m4a 需要先轉檔
        session = self.restart()[UUID]
        self.assertEqual((session['temp_path'], session['original_filename'], session['base_folder']),
                         (str(path), '歌.m4a', 'B 人聲'))

    async def test_file_without_an_id_prefix_gets_one(self):
        self.temp_file('手動放的.flac')
        result = await music_import.resume_import(ResumeImportRequest(file_id='手動放的.flac', base_folder='B 人聲'))
        self.assertNotEqual(result.file_id, '手動放的.flac')
        renamed = self.wait_import / f'{result.file_id}_手動放的.flac'
        self.assertTrue(renamed.exists())
        self.assertEqual(result.next_action, 'extract-tags')
        pending = (await music_import.list_pending_imports()).pending_imports
        self.assertEqual([(p['file_id'], p['status'], p['needs_base_folder']) for p in pending],
                         [(result.file_id, 'uploaded', False)])

    async def test_finished_or_missing_imports_cannot_be_resumed(self):
        music_import.update_import_status(UUID, ImportStatus.UPLOADED, temp_path=str(self.wait_import / 'gone.flac'),
                                          base_folder='B 人聲')
        with self.assertRaises(HTTPException) as gone:
            await music_import.resume_import(ResumeImportRequest(file_id=UUID))
        self.assertEqual(gone.exception.status_code, 404)
        music_import.update_import_status(UUID, ImportStatus.COMPLETED)
        with self.assertRaises(HTTPException) as done:
            await music_import.resume_import(ResumeImportRequest(file_id=UUID))
        self.assertEqual(done.exception.status_code, 400)

    async def test_pending_list_marks_lost_sessions_and_skips_partial_files(self):
        self.temp_file(f'{UUID}_lost.flac')
        self.temp_file('other_upload.flac.assembling')
        pending = (await music_import.list_pending_imports()).pending_imports
        self.assertEqual([(p['file_id'], p['status'], p['needs_base_folder'], p['next_action']) for p in pending],
                         [(UUID, 'orphaned', True, None)])

    def test_next_action_covers_every_unfinished_step(self):
        cases = {
            ('uploaded', False, False): 'extract-tags', ('uploaded', True, False): 'convert',
            ('converted', False, False): 'extract-tags', ('tags_extracted', False, False): 'edit-tags',
            ('tags_edited', False, False): 'check-artist', ('artist_ready', False, True): 'artist-image',
            ('artist_ready', False, False): 'process-album', ('album_ready', False, False): 'finalize',
            ('ready_to_move', False, False): 'confirm-move', ('completed', False, False): None,
        }
        for (status, conversion, image), expected in cases.items():
            with self.subTest(status=status):
                self.assertEqual(music_import.next_action_for(
                    {'status': status, 'needs_conversion': conversion, 'needs_artist_image': image}), expected)

    async def test_artist_photo_is_still_needed_while_another_artist_lacks_one(self):
        path = self.temp_file(f'{UUID}_duet.flac')
        music_import.update_import_status(UUID, ImportStatus.TAGS_EDITED, temp_path=str(path), base_folder='B 人聲')
        from app.schemas.music_import import CheckArtistRequest
        await music_import.check_artist_folder(CheckArtistRequest(file_id=UUID, artist_name='甲;乙'))
        self.assertTrue(music_import.import_sessions[UUID]['needs_artist_image'])

        await music_import.upload_artist_image(file_id=UUID, artist_name='甲',
                                               image=UploadFile(file=io.BytesIO(b'jpg'), filename='a.jpg'))
        session = self.restart()[UUID]
        self.assertTrue(session['needs_artist_image'])  # 乙 還沒有照片
        self.assertEqual(music_import.next_action_for(session), 'artist-image')

        await music_import.upload_artist_image(file_id=UUID, artist_name='乙',
                                               image=UploadFile(file=io.BytesIO(b'jpg'), filename='b.png'))
        self.assertFalse(music_import.import_sessions[UUID]['needs_artist_image'])


if __name__ == '__main__':
    unittest.main()
