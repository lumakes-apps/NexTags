"""音樂庫檔案路徑規則：/Music/<資料夾>/Music/<第一位歌手>/<專輯>/<編號 - 標題>.<副檔名>

編輯標籤時只替換「這次改到的欄位」對應的那一段路徑，其他段落沿用目前的名稱，
避免把既有的資料夾命名（大小寫、舊的清理規則、刻意取的名稱）改掉。
"""
import os
from typing import Any, Dict, List, Optional

from app.dependencies.mp3tag_writer import coerce_number
from app.dependencies.utils.path_sanitizer import sanitize_file_name, sanitize_folder_name

MUSIC_ROOT = '/Music'


def first_artist(value: Any) -> str:
    if isinstance(value, (list, tuple)):
        value = ';'.join(str(v) for v in value)
    names = [name.strip() for name in str(value or '').split(';') if name.strip()]
    return names[0] if names else ''


def _text(value: Any) -> str:
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ''
    return str(value or '').strip()


def suggested_filename(tags: Dict[str, Any], extension: str) -> str:
    """與匯入流程相同的檔名規則：兩位數編號 - 標題。"""
    track = (coerce_number(tags.get('tracknumber')) or '1').zfill(2)
    return sanitize_file_name(f"{track} - {_text(tags.get('title')) or '未知標題'}.{extension}")


def split_library_path(path: str) -> Optional[Dict[str, str]]:
    """拆出 base / artist / album / filename；不符合音樂庫結構時回傳 None。"""
    relative = os.path.relpath(path, MUSIC_ROOT)
    parts = relative.split(os.sep)
    if relative.startswith('..') or len(parts) != 5 or parts[1] != 'Music':
        return None
    base, _, artist, album, filename = parts
    return {'base': base, 'artist': artist, 'album': album, 'filename': filename}


def join_library_path(parts: Dict[str, str]) -> str:
    return os.path.join(MUSIC_ROOT, parts['base'], 'Music', parts['artist'], parts['album'], parts['filename'])


def propose_path(path: str, old_tags: Dict[str, Any], new_tags: Dict[str, Any],
                 filename: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """依照這次改到的欄位計算新路徑。

    回傳 {current, proposed, changed}；沒有改到任何影響路徑的欄位、或檔案不在標準結構內時回傳 None。
    filename 可覆寫建議的檔名（使用者在確認視窗中修改）。
    """
    parts = split_library_path(path)
    if parts is None:
        return None

    changed: List[str] = []
    proposed = dict(parts)

    new_artist = first_artist(new_tags.get('artist'))
    if new_artist and new_artist != first_artist(old_tags.get('artist')):
        proposed['artist'] = sanitize_folder_name(new_artist)
        changed.append('artist')

    new_album = _text(new_tags.get('album'))
    if new_album and new_album != _text(old_tags.get('album')):
        proposed['album'] = sanitize_folder_name(new_album)
        changed.append('album')

    title_changed = _text(new_tags.get('title')) != _text(old_tags.get('title'))
    track_changed = coerce_number(new_tags.get('tracknumber')) != coerce_number(old_tags.get('tracknumber'))
    extension = os.path.splitext(parts['filename'])[1].lstrip('.')
    if title_changed or track_changed:
        proposed['filename'] = suggested_filename(new_tags, extension)
        changed.append('filename')
    if filename:
        stem = os.path.splitext(filename)[0]
        proposed['filename'] = sanitize_file_name(f'{stem}.{extension}')
        if 'filename' not in changed:
            changed.append('filename')

    if not changed:
        return None
    return {'current': path, 'proposed': join_library_path(proposed), 'changed': changed}
