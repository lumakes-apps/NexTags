import unittest

from app.dependencies.path_rules import propose_path, split_library_path

PATH = '/Music/B 人聲/Music/Joy/Album A/01 - Song.flac'
OLD = {'artist': 'JOY', 'album': 'Album A', 'title': 'Song', 'tracknumber': '1'}


class ProposePathTests(unittest.TestCase):
    def test_unrelated_changes_do_not_move(self):
        self.assertIsNone(propose_path(PATH, OLD, {**OLD, 'lyrics': 'new', 'genre': ['Pop']}))

    def test_title_change_only_renames_file_and_keeps_existing_folder_names(self):
        # 資料夾是 Joy、標籤是 JOY：只改標題時不能順便把資料夾改成 JOY
        result = propose_path(PATH, OLD, {**OLD, 'title': 'New: Song'})
        self.assertEqual(result['proposed'], '/Music/B 人聲/Music/Joy/Album A/01 - New - Song.flac')
        self.assertEqual(result['changed'], ['filename'])

    def test_track_number_change_renames_file(self):
        result = propose_path(PATH, OLD, {**OLD, 'tracknumber': '7'})
        self.assertEqual(result['proposed'], '/Music/B 人聲/Music/Joy/Album A/07 - Song.flac')

    def test_album_change_moves_only_the_album_segment(self):
        result = propose_path(PATH, OLD, {**OLD, 'album': 'Album B'})
        self.assertEqual(result['proposed'], '/Music/B 人聲/Music/Joy/Album B/01 - Song.flac')
        self.assertEqual(result['changed'], ['album'])

    def test_only_the_first_artist_matters(self):
        self.assertIsNone(propose_path(PATH, OLD, {**OLD, 'artist': 'JOY;Guest'}))
        result = propose_path(PATH, OLD, {**OLD, 'artist': 'Guest;JOY'})
        self.assertEqual(result['proposed'], '/Music/B 人聲/Music/Guest/Album A/01 - Song.flac')

    def test_emptied_fields_do_not_move(self):
        self.assertIsNone(propose_path(PATH, OLD, {**OLD, 'artist': '', 'album': ''}))

    def test_custom_filename_keeps_extension(self):
        result = propose_path(PATH, OLD, {**OLD, 'title': 'X'}, filename='My Name.mp3')
        self.assertEqual(result['proposed'], '/Music/B 人聲/Music/Joy/Album A/My Name.flac')

    def test_files_outside_the_library_layout_are_ignored(self):
        self.assertIsNone(split_library_path('/Music/B 人聲/Loose/01 - Song.flac'))
        self.assertIsNone(propose_path('/Music/B 人聲/Loose/01 - Song.flac', OLD, {**OLD, 'title': 'X'}))


if __name__ == '__main__':
    unittest.main()
