import base64
from io import BytesIO
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.dependencies.utils.cover_art import decode_cover_data, get_cover_data_from_audio, write_audio_cover


def image_data(fmt='JPEG'):
    output = BytesIO()
    Image.new('RGB', (12, 8), 'red').save(output, format=fmt)
    data = output.getvalue()
    mime = 'image/jpeg' if fmt == 'JPEG' else 'image/png'
    return f'data:{mime};base64,' + base64.b64encode(data).decode(), data


class CoverValidationTests(unittest.TestCase):
    def test_rejects_invalid_or_mislabelled_images(self):
        for value in ['not an image', 'data:image/jpeg;base64,!!!!',
                      'data:image/svg+xml;base64,PHN2Zz4=',
                      image_data('PNG')[0].replace('image/png', 'image/jpeg')]:
            with self.subTest(value=value[:40]), self.assertRaises(ValueError):
                decode_cover_data(value)

    def test_rejects_oversized_image_before_decoding(self):
        with patch('app.dependencies.utils.cover_art.MAX_COVER_BYTES', 3):
            with self.assertRaises(ValueError):
                decode_cover_data(image_data()[0])


@unittest.skipUnless(shutil.which('ffmpeg'), 'Audio integration tests require ffmpeg')
class CoverPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def make_audio(self, extension='flac'):
        target = self.root / f'song.{extension}'
        # 不指定 codec 時，缺 libvorbis 的 ffmpeg（如 Homebrew）會把 .ogg 編成 Ogg FLAC；
        # 改用內建 vorbis 編碼器（僅支援雙聲道）確保產生 Ogg Vorbis。
        codec = ['-ac', '2', '-c:a', 'vorbis', '-strict', '-2'] if extension == 'ogg' else []
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
                        '-t', '0.05', *codec, '-metadata', 'title=Original title', str(target)],
                       check=True, capture_output=True)
        return target

    def test_cover_replacement_persists_in_all_supported_formats(self):
        for extension in ['flac', 'mp3', 'm4a', 'ogg']:
            with self.subTest(extension=extension):
                target = self.make_audio(extension)
                def pcm_digest():
                    return subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(target), '-map', '0:a:0', '-f', 'md5', '-'])
                original = pcm_digest()
                for fmt, name in [('JPEG', 'cover.jpg'), ('PNG', 'cover.png')]:
                    data_url, expected = image_data(fmt)
                    cover_path = write_audio_cover(str(target), decode_cover_data(data_url))
                    self.assertEqual(Path(cover_path), self.root / name)
                    self.assertEqual(Path(cover_path).read_bytes(), expected)
                    self.assertEqual(get_cover_data_from_audio(str(target))[0], expected)
                    self.assertEqual(pcm_digest(), original)
                self.assertFalse((self.root / 'cover.jpg').exists())

    def make_client(self):
        # Isolate module initialization from any production SQLite database.
        with patch.dict(os.environ, {'SQLITE_DB_PATH': str(self.root / 'test.db')}):
            from app.router import audio
        self.audio = audio
        app = FastAPI()
        app.include_router(audio.router)
        self.cache = Mock()
        self.cache.get_audio_records.return_value = []
        for patcher in [patch.object(audio, 'MUSIC_ROOT', self.root, create=True),
                        patch.object(audio, 'redis_cache', self.cache),
                        patch.object(audio, 'get_folder_from_path', return_value='B 人聲')]:
            patcher.start()
            self.addCleanup(patcher.stop)
        hook = patch.object(audio, 'request_navidrome_refresh', create=True)
        self.hook = hook.start()
        self.addCleanup(hook.stop)
        return TestClient(app)

    def test_save_updates_tags_embedded_cover_folder_and_index(self):
        target = self.make_audio()
        client = self.make_client()
        data_url, image = image_data()
        sibling = self.root / 'other.flac'
        sibling.write_bytes(target.read_bytes())
        self.cache.get_audio_records.return_value = [{'file_path': str(sibling), 'tags': {'title': 'Other'}}]
        result = client.put('/audios/update', json={'path': str(target), 'tags': [{'title': 'Updated title'}], 'cover_data': data_url})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertTrue(result.json()['success'])
        self.assertEqual(result.json()['cover_path'], str(self.root / 'cover.jpg'))
        self.assertEqual(get_cover_data_from_audio(str(target))[0], image)
        self.assertEqual((self.root / 'cover.jpg').read_bytes(), image)
        from mutagen.flac import FLAC
        self.assertEqual(FLAC(target)['title'], ['Updated title'])
        self.assertEqual(self.cache.upsert_audio_record.call_count, 2)
        self.hook.assert_called_once()

    def test_invalid_image_does_not_change_the_audio_or_report_success(self):
        target = self.make_audio()
        original = target.read_bytes()
        client = self.make_client()
        result = client.put('/audios/update', json={'path': str(target), 'tags': [{'title': 'Should not be saved'}], 'cover_data': 'data:image/jpeg;base64,!!!!'})
        self.assertEqual(result.status_code, 400)
        self.assertEqual(target.read_bytes(), original)
        self.cache.upsert_audio_record.assert_not_called()
        self.hook.assert_not_called()

    def test_tag_only_save_preserves_the_existing_cover(self):
        target = self.make_audio()
        data_url, image = image_data()
        write_audio_cover(str(target), decode_cover_data(data_url))
        client = self.make_client()
        result = client.put('/audios/update', json={'path': str(target), 'tags': [{'title': 'New title'}]})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(get_cover_data_from_audio(str(target))[0], image)
        self.assertEqual((self.root / 'cover.jpg').read_bytes(), image)
        self.hook.assert_not_called()

    def test_missing_or_outside_paths_keep_the_correct_error_status(self):
        client = self.make_client()
        for path, status in [(str(self.root / 'missing.flac'), 404), ('/etc/passwd', 400)]:
            result = client.put('/audios/update', json={'path': path, 'tags': []})
            self.assertEqual(result.status_code, status, result.text)

    def test_cover_write_failure_is_visible_and_does_not_refresh_index(self):
        target = self.make_audio()
        client = self.make_client()
        with patch.object(self.audio, 'write_audio_cover', side_effect=PermissionError('cover directory is not writable')):
            result = client.put('/audios/update', json={'path': str(target), 'tags': [], 'cover_data': image_data()[0]})
        self.assertEqual(result.status_code, 500)
        self.cache.upsert_audio_record.assert_not_called()
        self.hook.assert_not_called()


if __name__ == '__main__':
    unittest.main()
