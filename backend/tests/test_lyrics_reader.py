import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from mutagen.id3 import ID3, USLT
from mutagen.mp3 import MP3

from app.dependencies.mp3tag_reader import normalize_tag_keys, read_audio_tags


TEXT = '[00:01.00]測試文字\n[00:02.00]Second test line'


class LyricsReaderTests(unittest.TestCase):
    def test_reads_uslt_languages_and_descriptions(self):
        for language, description in (
            ('XXX', ''), ('zho', ''), ('kor', ''),
            ('eng', 'Original'), ('kor', 'Version: Original'),
        ):
            with self.subTest(language=language, description=description):
                frame = USLT(encoding=3, lang=language, desc=description, text=TEXT)
                raw = {frame.HashKey: frame, 'TXXX:OTHER': 'keep me'}
                normalized = normalize_tag_keys(raw)
                self.assertEqual(normalized['lyrics'], TEXT)
                self.assertIs(normalized[frame.HashKey], frame)
                self.assertEqual(normalized['TXXX:OTHER'], 'keep me')
                self.assertNotIn('lyrics', raw)

    def test_preserves_existing_nonempty_lyrics_precedence(self):
        alternate = USLT(encoding=3, lang='kor', text='Alternate test text')
        english = USLT(encoding=3, lang='eng', text=TEXT)
        raw = {alternate.HashKey: alternate, english.HashKey: english}
        self.assertEqual(normalize_tag_keys(raw)['lyrics'], TEXT)
        raw['lyrics'] = 'Existing normalized text'
        self.assertEqual(normalize_tag_keys(raw)['lyrics'], 'Existing normalized text')

    def test_blank_english_frame_does_not_hide_other_languages(self):
        for empty in ('', ' \n\t'):
            with self.subTest(empty=repr(empty)):
                raw = {
                    'USLT::eng': USLT(encoding=3, lang='eng', text=empty),
                    'USLT::XXX': USLT(encoding=3, lang='XXX', text=TEXT),
                }
                self.assertEqual(normalize_tag_keys(raw)['lyrics'], TEXT)

    def test_fallback_is_independent_of_tag_insertion_order(self):
        frames = {
            'USLT::zho': USLT(encoding=3, lang='zho', text='Chinese test text'),
            'USLT::kor': USLT(encoding=3, lang='kor', text=TEXT),
        }
        self.assertEqual(normalize_tag_keys(frames)['lyrics'], TEXT)
        self.assertEqual(normalize_tag_keys(dict(reversed(list(frames.items()))))['lyrics'], TEXT)

    def test_reads_serialized_uslt_from_cache(self):
        for value in (TEXT, [TEXT]):
            with self.subTest(value_type=type(value).__name__):
                self.assertEqual(normalize_tag_keys({'USLT::XXX': value})['lyrics'], TEXT)

    def test_preserves_other_formats_and_ignores_empty_frames(self):
        for key in ('lyrics', 'LYRICS', 'UNSYNCEDLYRICS', '\xa9lyr'):
            with self.subTest(key=key):
                self.assertEqual(normalize_tag_keys({key: [TEXT]})['lyrics'], TEXT)
        self.assertNotIn('lyrics', normalize_tag_keys({'USLT::XXX': ' \n'}))
        self.assertNotIn('lyrics', normalize_tag_keys({'USLT::XXX': None}))
        self.assertNotIn('lyrics', normalize_tag_keys({'TIT2': 'Test title'}))

    def test_read_audio_tags_preserves_id3_file_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.mp3'
            tags = ID3()
            tags.add(USLT(encoding=3, lang='XXX', text=TEXT))
            tags.save(path)
            before = path.read_bytes()
            # Use a real ID3 round trip; only MPEG format detection is mocked.
            with patch('app.dependencies.mp3tag_reader.mutagen.File', return_value=MP3.__new__(MP3)):
                self.assertEqual(read_audio_tags(path)['lyrics'], TEXT)
            self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
