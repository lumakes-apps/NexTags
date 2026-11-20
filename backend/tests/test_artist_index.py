import unittest

from app.dependencies.artist_index import build_artist_index, split_names


class SplitNamesTests(unittest.TestCase):
    def test_accepts_strings_lists_and_empty_values(self):
        self.assertEqual(split_names('A; B;;'), ['A', 'B'])
        self.assertEqual(split_names(['A', ' ', 'B ']), ['A', 'B'])
        self.assertEqual(split_names(None), [])
        self.assertEqual(split_names(''), [])


class BuildArtistIndexTests(unittest.TestCase):
    def index(self, *tags):
        return {entry['name']: entry for entry in build_artist_index(tags)}

    def test_counts_names_per_role_across_songs(self):
        result = self.index(
            {'artist': '周杰倫', 'composer': '周杰倫'},
            {'artist': '周杰倫;蔡依林', 'albumartist': '蔡依林', 'performer': 'TWICE'},
        )
        self.assertEqual(result['周杰倫']['roles'], {'artist': 2, 'composer': 1})
        self.assertEqual(result['蔡依林']['roles'], {'artist': 1, 'albumartist': 1})
        self.assertEqual(result['TWICE']['roles'], {'performer': 1})

    def test_sort_name_is_most_common_aligned_pair(self):
        result = self.index(
            {'artist': '曾沛慈', 'artistsort': 'cengpeici'},
            {'artist': '曾沛慈', 'artistsort': 'zengpeici'},
            {'composer': '曾沛慈', 'composersort': 'zengpeici'},
        )
        self.assertEqual(result['曾沛慈']['sort'], 'zengpeici')

    def test_misaligned_sort_values_are_ignored(self):
        result = self.index({'artist': 'A;B', 'artistsort': 'onlyone'})
        self.assertEqual(result['A']['sort'], '')
        self.assertEqual(result['B']['sort'], '')

    def test_ordered_by_total_usage_then_name(self):
        names = [e['name'] for e in build_artist_index([
            {'artist': 'B'}, {'artist': 'A'}, {'artist': 'C', 'composer': 'C'},
        ])]
        self.assertEqual(names, ['C', 'A', 'B'])


if __name__ == '__main__':
    unittest.main()
