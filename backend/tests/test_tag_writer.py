import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mutagen.flac import FLAC
from mutagen.id3 import ID3, TLAN, TXXX, USLT

from app.dependencies.mp3tag_reader import read_audio_tags
from app.dependencies.mp3tag_writer import write_tags

FORMATS = ['mp3', 'flac', 'm4a', 'ogg']

FULL_TAGS = {
    'title': 'Title', 'artist': 'A;B', 'album': 'Album', 'titlesort': 'title sort',
    'tracknumber': '3', 'tracktotal': '10', 'discnumber': '1', 'disctotal': '2',
    'genre': ['Pop', 'Rock'], 'language': 'zh', 'favorite': 'True',
    'comment': 'note', 'lyrics': '[00:00.00]line',
}

CLEARED_TAGS = {
    'title': 'Title', 'artist': 'A;B', 'album': 'Album', 'titlesort': '',
    'tracknumber': '', 'tracktotal': '', 'discnumber': '', 'disctotal': '',
    'genre': [], 'language': '', 'favorite': 'False', 'comment': '', 'lyrics': '',
}


@unittest.skipUnless(shutil.which('ffmpeg'), 'Tag writer integration tests require ffmpeg')
class TagWriterRoundTripTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        genres = patch('app.dependencies.mp3tag_writer.load_supported_genres', return_value=['Pop', 'Rock'])
        genres.start()
        self.addCleanup(genres.stop)

    def make_audio(self, extension):
        target = Path(self.temp.name) / f'song.{extension}'
        # 缺 libvorbis 的 ffmpeg 會把 .ogg 編成 Ogg FLAC，強制使用內建 vorbis 編碼器
        codec = ['-c:a', 'vorbis', '-strict', '-2'] if extension == 'ogg' else []
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
                        '-t', '0.05', *codec, str(target)], check=True, capture_output=True)
        return str(target)

    def write(self, path, tags):
        self.assertTrue(write_tags(path, tags))
        return read_audio_tags(path)

    def test_values_round_trip(self):
        for extension in FORMATS:
            with self.subTest(extension=extension):
                tags = self.write(self.make_audio(extension), FULL_TAGS)
                self.assertEqual(tags['artist'], 'A;B')
                self.assertEqual(tags['titlesort'], 'title sort')
                self.assertEqual((tags['tracknumber'], tags['tracktotal']), ('3', '10'))
                self.assertEqual((tags['discnumber'], tags['disctotal']), ('1', '2'))
                self.assertEqual(tags['genre'], ['Pop', 'Rock'])
                self.assertEqual((tags['language'], tags['favorite']), ('zh', 'True'))
                self.assertEqual((tags['comment'], tags['lyrics']), ('note', '[00:00.00]line'))

    def test_empty_values_remove_fields(self):
        for extension in FORMATS:
            with self.subTest(extension=extension):
                path = self.make_audio(extension)
                self.write(path, FULL_TAGS)
                tags = self.write(path, CLEARED_TAGS)
                for key in ['titlesort', 'tracknumber', 'tracktotal', 'discnumber', 'disctotal',
                            'language', 'comment', 'lyrics']:
                    self.assertFalse(tags.get(key), f'{key} should be cleared, got {tags.get(key)!r}')
                self.assertFalse(tags.get('genre'))
                self.assertEqual(tags['favorite'], 'False')
                self.assertEqual(tags['title'], 'Title')

    def test_missing_keys_are_left_untouched(self):
        for extension in FORMATS:
            with self.subTest(extension=extension):
                path = self.make_audio(extension)
                self.write(path, {**FULL_TAGS, 'replaygain_album_gain': '-6.00 dB'})
                tags = self.write(path, {'title': 'New', 'tracknumber': '4'})
                self.assertEqual(tags['title'], 'New')
                self.assertEqual((tags['tracknumber'], tags['tracktotal']), ('4', '10'))
                self.assertEqual(tags['replaygain_album_gain'], '-6.00 dB')
                self.assertEqual(tags['lyrics'], '[00:00.00]line')

    def test_genres_outside_supported_list_are_removed(self):
        for extension in FORMATS:
            with self.subTest(extension=extension):
                path = self.make_audio(extension)
                self.write(path, FULL_TAGS)
                self.assertEqual(self.write(path, {'genre': ['Pop', 'Unknown']})['genre'], ['Pop'])
                self.assertFalse(self.write(path, {'genre': ['Unknown']}).get('genre'))

    def test_genres_are_not_filtered_without_supported_list(self):
        path = self.make_audio('flac')
        with patch('app.dependencies.mp3tag_writer.load_supported_genres', return_value=[]):
            self.assertEqual(self.write(path, {'genre': ['Anything']})['genre'], ['Anything'])

    def test_import_payload_prefers_normalized_keys_over_raw_aliases(self):
        path = self.make_audio('flac')
        audio = FLAC(path)
        audio['TITLE'] = ['Title']
        audio['TOTALTRACKS'] = ['10']  # 其他軟體常用的別名鍵
        audio.save()
        payload = read_audio_tags(path)
        self.assertEqual((payload['totaltracks'], payload['tracktotal']), (['10'], '10'))
        payload.update({'tracktotal': '', 'title': 'Edited'})
        tags = self.write(path, payload)
        self.assertFalse(tags.get('tracktotal'))
        self.assertNotIn('totaltracks', tags)
        self.assertEqual(tags['title'], 'Edited')
        self.assertNotIn('[', FLAC(path)['encoder'][0])  # 列表值不得被 str() 寫成 "['...']"

    def test_mp3_lyrics_in_other_languages_do_not_come_back(self):
        path = self.make_audio('mp3')
        id3 = ID3()
        id3.add(USLT(encoding=3, lang='chi', desc='', text='old lyrics'))
        id3.save(path)
        self.assertEqual(self.write(path, {'lyrics': 'new lyrics'})['lyrics'], 'new lyrics')
        self.assertEqual([k for k in ID3(path) if k.startswith('USLT')], ['USLT::eng'])
        self.assertFalse(self.write(path, {'lyrics': ''}).get('lyrics'))

    def test_mp3_language_writes_tlan_and_txxx_together(self):
        path = self.make_audio('mp3')
        id3 = ID3()
        id3.add(TLAN(encoding=3, text='jpn'))
        id3.add(TXXX(encoding=3, desc='Favorite', text='True'))
        id3.save(path)
        tags = self.write(path, {'language': 'chi', 'favorite': 'False'})
        self.assertEqual((tags['language'], tags['favorite']), ('chi', 'False'))
        frames = ID3(path)
        self.assertEqual((frames['TLAN'].text, frames['TXXX:LANGUAGE'].text), (['chi'], ['chi']))
        self.assertFalse(self.write(path, {'language': ''}).get('language'))
        self.assertFalse({'TLAN', 'TXXX:LANGUAGE'} & set(ID3(path).keys()))


if __name__ == '__main__':
    unittest.main()
