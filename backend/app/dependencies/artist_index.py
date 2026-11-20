from collections import Counter, defaultdict
from typing import Any, Dict, Iterable, List

# 標籤編輯器中以「歌手標籤」編輯的欄位 -> 對應的排序欄位
ARTIST_ROLES = {
    'artist': 'artistsort',
    'albumartist': 'albumartistsort',
    'composer': 'composersort',
    'performer': 'performersort',
}


def split_names(value: Any) -> List[str]:
    """把多值欄位（分號分隔字串或列表）拆成乾淨的名字列表。"""
    if value is None:
        return []
    items = value if isinstance(value, (list, tuple)) else str(value).split(';')
    return [str(item).strip() for item in items if str(item).strip()]


def build_artist_index(all_tags: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """彙整音樂庫中所有歌手類欄位的名字。

    回傳每個名字在各欄位的使用次數，以及最常與它配對的排序名稱
    （僅在名字與排序欄位數量一致時才能配對）。依總使用次數由多到少排列。
    """
    role_counts: Dict[str, Counter] = defaultdict(Counter)
    sort_counts: Dict[str, Counter] = defaultdict(Counter)

    for tags in all_tags:
        for role, sort_role in ARTIST_ROLES.items():
            names = split_names(tags.get(role))
            for name in names:
                role_counts[name][role] += 1
            sorts = split_names(tags.get(sort_role))
            if names and len(names) == len(sorts):
                for name, sort in zip(names, sorts):
                    sort_counts[name][sort] += 1

    index = [
        {
            'name': name,
            'sort': sort_counts[name].most_common(1)[0][0] if sort_counts[name] else '',
            'roles': dict(roles),
        }
        for name, roles in role_counts.items()
    ]
    index.sort(key=lambda item: (-sum(item['roles'].values()), item['name']))
    return index
