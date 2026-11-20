import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import path_rules
from app.dependencies.mp3tag_reader import read_audio_tags
from app.dependencies.mp3tag_writer import write_tags


@unittest.skipUnless(shutil.which('ffmpeg'), 'Move API tests require ffmpeg')
class MoveApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.album = self.root / 'B 人聲/Music/Artist/Album'
        self.album.mkdir(parents=True)
        self.song = self.album / '01 - Song.flac'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.05',
                        str(self.song)], check=True, capture_output=True)
        write_tags(str(self.song), {'title': 'Song', 'artist': 'Artist', 'album': 'Album', 'tracknumber': '1'})
        shutil.copy(self.song, self.album / '02 - Other.flac')

        with patch.dict(os.environ, {'SQLITE_DB_PATH': str(self.root / 'test.db')}):
            from app.router import audio
        self.audio = audio
        app = FastAPI()
        app.include_router(audio.router)
        self.client = TestClient(app)
        self.queued = []
        for patcher in (
            patch.object(audio, 'MUSIC_ROOT', self.root),
            patch.object(path_rules, 'MUSIC_ROOT', str(self.root)),
            patch.object(audio, 'redis_cache', Mock()),
            patch.object(audio, 'emit_event'),
            patch.object(audio.pending_moves, 'redis_cache', Mock()),
            patch.object(audio.pending_moves, 'get_move', return_value=None),
            patch.object(audio.pending_moves, 'queue_move',
                         side_effect=lambda s, t: self.queued.append((s, t)) or {'source': s, 'target': t}),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def body(self, **tags):
        return {'path': str(self.song), 'tags': [{'title': 'Song', 'artist': 'Artist', 'album': 'Album',
                                                    'tracknumber': '1', **tags}]}

    def test_preview_reports_new_path_and_songs_left_behind(self):
        result = self.client.post('/audios/move-preview', json=self.body(album='New Album')).json()
        self.assertEqual(result['proposal']['proposed'], str(self.root / 'B 人聲/Music/Artist/New Album/01 - Song.flac'))
        self.assertEqual(result['others_in_folder'], 1)
        self.assertFalse(result['conflict'])
        self.assertIsNone(self.client.post('/audios/move-preview', json=self.body(lyrics='x')).json()['proposal'])

    def test_save_with_move_writes_tags_then_queues_the_move(self):
        result = self.client.put('/audios/update', json={**self.body(title='New Title'), 'move': True})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(read_audio_tags(str(self.song))['title'], 'New Title')
        self.assertEqual(self.queued, [(str(self.song), str(self.album / '01 - New Title.flac'))])
        self.assertTrue(self.song.exists())  # 實際搬移要等 Navidrome 掃描
        self.assertIn('Navidrome 掃描後移動', result.json()['message'])

    def test_save_without_move_only_writes_tags(self):
        self.client.put('/audios/update', json=self.body(title='New Title'))
        self.assertEqual(self.queued, [])

    def test_conflict_is_rejected_before_writing_tags(self):
        (self.album / '01 - Taken.flac').write_bytes(b'existing')
        result = self.client.put('/audios/update', json={**self.body(title='Taken'), 'move': True})
        self.assertEqual(result.status_code, 409)
        self.assertEqual(read_audio_tags(str(self.song))['title'], 'Song')
        self.assertEqual(self.queued, [])


if __name__ == '__main__':
    unittest.main()
