import unittest

from app.dependencies.utils.path_sanitizer import sanitize_file_name, sanitize_folder_name


class SanitizeFolderNameTests(unittest.TestCase):
    def test_replaces_ascii_colon(self):
        self.assertEqual(sanitize_folder_name("秋:故事"), "秋 - 故事")

    def test_replaces_fullwidth_and_private_use_colons(self):
        self.assertEqual(sanitize_folder_name("TEN： The Story"), "TEN - The Story")
        self.assertEqual(sanitize_folder_name("EVE\uf03a ROMANCE"), "EVE - ROMANCE")

    def test_normalizes_spacing_around_colons(self):
        self.assertEqual(sanitize_folder_name("A :  B"), "A - B")

    def test_replaces_all_ascii_fat_invalid_characters(self):
        for invalid_char in '"*/:<>?\\|\x01\x7f':
            with self.subTest(invalid_char=repr(invalid_char)):
                self.assertEqual(
                    sanitize_folder_name(f"A{invalid_char}B"),
                    "A - B",
                )

    def test_replaces_fullwidth_and_private_use_lookalikes(self):
        lookalikes = "＂＊／：＜＞？＼｜\uf022\uf02a\uf02f\uf03a\uf03c\uf03e\uf03f\uf05c\uf07c"
        for invalid_char in lookalikes:
            with self.subTest(invalid_char=repr(invalid_char)):
                self.assertEqual(
                    sanitize_folder_name(f"A{invalid_char}B"),
                    "A - B",
                )

    def test_removes_invalid_characters_at_name_edges(self):
        self.assertEqual(
            sanitize_folder_name("燕尾蝶<下定愛的決心>"),
            "燕尾蝶 - 下定愛的決心",
        )
        self.assertEqual(sanitize_folder_name("?Question?"), "Question")

    def test_removes_trailing_spaces_and_periods(self):
        self.assertEqual(sanitize_folder_name("Album.  "), "Album")

    def test_uses_fallback_for_an_empty_sanitized_name(self):
        self.assertEqual(sanitize_folder_name("<>"), "_")

    def test_leaves_regular_tag_text_unchanged(self):
        self.assertEqual(sanitize_folder_name("The Story Begins - EP"), "The Story Begins - EP")

    def test_sanitizes_filename_stem_and_preserves_extension(self):
        self.assertEqual(
            sanitize_file_name("01 - 外灘十八號（Cover:袁成傑）.mp3"),
            "01 - 外灘十八號（Cover - 袁成傑）.mp3",
        )
        self.assertEqual(
            sanitize_file_name("01 - 你，好不好?.flac"),
            "01 - 你，好不好.flac",
        )

    def test_leaves_regular_filename_unchanged(self):
        self.assertEqual(sanitize_file_name("01 - The Story.flac"), "01 - The Story.flac")


if __name__ == "__main__":
    unittest.main()
