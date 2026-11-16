import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.router import music_import
from app.schemas.music_import import (
    CheckArtistRequest,
    ConfirmMoveRequest,
    ExtractTagsRequest,
    FinalizeFileRequest,
    ImportStatus,
    ProcessAlbumRequest,
    UpdateTagsRequest,
)


class SuggestedFilenameTests(unittest.TestCase):
    def test_empty_tags_have_readable_defaults(self):
        for tags in ({}, {'title': '', 'tracknumber': ''}, {'title': [], 'tracknumber': None}):
            with self.subTest(tags=tags):
                self.assertEqual(
                    music_import.generate_suggested_filename(tags, 'flac'),
                    '01 - 未知標題.flac',
                )

    def test_list_and_track_total_are_normalized(self):
        self.assertEqual(
            music_import.generate_suggested_filename(
                {'title': ['求神呐'], 'tracknumber': ['3/11']}, 'mp3'
            ),
            '03 - 求神呐.mp3',
        )


@unittest.skipUnless(shutil.which('ffmpeg'), 'FLAC integration tests require ffmpeg')
class ImportEditedTagsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.audio_path = self.root / 'original.flac'
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
             '-t', '0.05', '-c:a', 'flac', str(self.audio_path)],
            check=True, capture_output=True,
        )
        self.original_tags = {
            'title': '-', 'artist': '呜米', 'album': '求神呐 - 翻唱', 'tracknumber': '',
        }
        self.assertTrue(music_import.write_tags(str(self.audio_path), self.original_tags))
        self.file_id = 'edited-tags-regression'
        music_import.update_import_status(
            self.file_id, ImportStatus.UPLOADED,
            temp_path=str(self.audio_path), base_folder='B 人聲', format='flac',
            original_filename='original.flac',
        )
        self.addCleanup(music_import.import_sessions.pop, self.file_id, None)
        for patcher in (
            patch.object(music_import, 'get_music_base_path', return_value=str(self.root)),
            patch.object(music_import, 'generate_replaygain', return_value=(True, 'test')),
            patch.object(music_import, 'extract_cover_from_audio', return_value=(False, '')),
            patch.object(music_import, 'redis_cache', None),
            patch.object(music_import, 'request_navidrome_refresh'),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    async def save_edited_tags(self):
        await music_import.extract_music_tags(ExtractTagsRequest(file_id=self.file_id))
        self.edited_tags = {**self.original_tags, 'title': '求神呐', 'tracknumber': '3'}
        return await music_import.update_music_tags(
            UpdateTagsRequest(file_id=self.file_id, tags=self.edited_tags)
        )

    async def test_saved_tags_refresh_the_editor_and_suggested_filename(self):
        result = await self.save_edited_tags()
        disk_tags = music_import.read_audio_tags(str(self.audio_path))
        session = music_import.import_sessions[self.file_id]
        self.assertEqual(disk_tags['title'], '求神呐')
        self.assertEqual(disk_tags['tracknumber'], '3')
        self.assertEqual(session['suggested_filename'], '03 - 求神呐.flac')
        self.assertEqual(result.updated_tags, disk_tags)
        self.assertEqual(session['extracted_tags'], disk_tags)
        self.assertEqual(session['updated_tags'], disk_tags)

    async def test_move_uses_latest_prepared_filename_and_keeps_saved_tags(self):
        await self.save_edited_tags()
        await music_import.check_artist_folder(
            CheckArtistRequest(file_id=self.file_id, artist_name='呜米')
        )
        await music_import.process_album_folder(
            ProcessAlbumRequest(file_id=self.file_id, artist_name='呜米', album_name='求神呐 - 翻唱')
        )
        session = music_import.import_sessions[self.file_id]
        old_preview = await music_import.finalize_file_preparation(
            FinalizeFileRequest(file_id=self.file_id, final_filename=session['suggested_filename'])
        )
        custom_filename = '03 - 自訂名稱.flac'
        await music_import.finalize_file_preparation(
            FinalizeFileRequest(file_id=self.file_id, final_filename=custom_filename)
        )
        result = await music_import.confirm_file_move(ConfirmMoveRequest(file_id=self.file_id))
        expected = self.root / 'B 人聲' / 'Music' / '呜米' / '求神呐 - 翻唱' / custom_filename
        self.assertEqual(result.final_path, str(expected))
        self.assertTrue(expected.exists())
        self.assertFalse(self.audio_path.exists())
        self.assertFalse(Path(old_preview.preview_final_path).exists())
        self.assertEqual(music_import.read_audio_tags(str(expected))['title'], '求神呐')
        self.assertEqual(session['status'], ImportStatus.COMPLETED)

    async def test_failed_write_does_not_publish_new_filename(self):
        await music_import.extract_music_tags(ExtractTagsRequest(file_id=self.file_id))
        session_before = dict(music_import.import_sessions[self.file_id])
        with patch.object(music_import, 'write_tags', return_value=False):
            with self.assertRaises(HTTPException):
                await music_import.update_music_tags(
                    UpdateTagsRequest(file_id=self.file_id, tags={'title': '未寫入'})
                )
        self.assertEqual(music_import.import_sessions[self.file_id], session_before)
        self.assertEqual(music_import.read_audio_tags(str(self.audio_path))['title'], '-')


if __name__ == '__main__':
    unittest.main()
