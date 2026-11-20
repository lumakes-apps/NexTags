import mutagen
from mutagen.mp4 import MP4, MP4FreeForm
from mutagen.flac import FLAC
from mutagen.mp3 import MP3
from mutagen.oggvorbis import OggVorbis
from mutagen.id3 import TIT2, TPE1, TALB, TPE2, TPE3, TCOM, TDRC, TRCK, TPOS, TSOT, TSOP, TSOA, TSO2, TSOC, TCON, TLAN, TXXX, COMM, USLT

from app.dependencies.logger import logger
from app.dependencies.mp3tag_reader import TAG_ALIASES

# 寫入語意（所有格式一致）：
#   - tags_dict 沒有的鍵：保持檔案原樣
#   - 有值：覆寫，並清除讀取端可能優先讀到的別名鍵
#   - 空值（''、None、空列表）：從檔案刪除該欄位與其別名

# (number 鍵, total 鍵, ID3 frame, MP4 atom)
NUMBER_PAIRS = [
    ('tracknumber', 'tracktotal', TRCK, 'trkn'),
    ('discnumber', 'disctotal', TPOS, 'disk'),
]
NUMBER_KEYS = {key for pair in NUMBER_PAIRS for key in pair[:2]}
CUSTOM_FIELDS = ['language', 'favorite', 'replaygain_track_gain', 'replaygain_track_peak',
                 'replaygain_album_gain', 'replaygain_album_peak']
MULTI_VALUE_FIELDS = {'artist', 'artistsort', 'albumartist', 'albumartistsort',
                      'composer', 'composersort', 'performer', 'performersort'}
# 不寫回檔案的欄位（僅供外部系統使用）
IGNORED_KEYS = {'jfid', 'jellyfin_add_time'}


def coerce_number(value) -> str:
    """把 disc/track 類欄位收斂成純數字字串，無法解析時回傳 ''。

    擋住歷史上造成標籤損壞的來源：若 value 是 list，直接 str() 會寫入
    "['3/11']" 這種字串並永久污染檔案。這裡統一剝殼、取斜線前段，
    並要求結果必須是純數字才寫入。
    """
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ''

    text = str(value).strip() if value is not None else ''

    while len(text) >= 2 and text[0] in '[(' and text[-1] in ')]':
        text = text[1:-1].strip()

    text = text.strip('\'"').strip()

    if '/' in text:
        text = text.partition('/')[0].strip()

    return text if text.isdigit() else ''


def load_supported_genres():
    """從資料庫載入支援的流派"""
    try:
        from app.router.config import get_config
        return get_config('supported_tags') or []
    except Exception as e:
        logger.error(f"載入設定失敗: {str(e)}")
        return []


def is_empty(value) -> bool:
    if value is None:
        return True
    if isinstance(value, (list, tuple)):
        return all(is_empty(v) for v in value)
    return str(value).strip() == ''


def to_values(key, value):
    """把欄位值轉成要寫入的字串列表；回傳 [] 代表刪除該欄位。"""
    if is_empty(value):
        return []
    if key == 'genre':
        # 強制流派合規：只寫入支援清單內的流派，不在清單內的一律移除；
        # 全部不合規時整個流派欄位清空。未設定支援清單時不過濾。
        genres = [str(v) for v in (value if isinstance(value, (list, tuple)) else [value]) if not is_empty(v)]
        supported = load_supported_genres()
        if not supported:
            return genres
        kept = [genre for genre in genres if genre in supported]
        if len(kept) < len(genres):
            logger.warning(f"流派 {[g for g in genres if g not in supported]} 不在支援清單中，已移除")
        return kept
    if key in MULTI_VALUE_FIELDS:
        # 多歌手以分號分隔
        items = value if isinstance(value, (list, tuple)) else str(value).split(';')
        return [str(v).strip() for v in items if not is_empty(v)]
    if isinstance(value, (list, tuple)):
        value = value[0]
    return [str(value)]


def _effective_items(tags_dict):
    """略過被標準欄位取代的原始別名鍵。

    匯入流程會把 read_audio_tags 的結果整包送回，其中同時含有原始鍵
    （如 FLAC 的 TRACKTOTAL）與標準化鍵（tracktotal）。同一欄位以標準鍵為準，
    避免原始鍵的舊值依字典順序蓋掉使用者剛編輯的值。
    """
    shadowed = {
        alias.lower()
        for key in tags_dict if key in TAG_ALIASES
        for alias in TAG_ALIASES[key] if alias != key
    }
    for key, value in tags_dict.items():
        if key in IGNORED_KEYS:
            continue
        if key not in TAG_ALIASES and key.lower() in shadowed:
            continue
        yield key, value


def _resolve_pair(tags_dict, number_key, total_key, existing_number, existing_total):
    """合併 number/total：tags_dict 沒提供的那一半沿用檔案現有值。"""
    number = coerce_number(tags_dict[number_key]) if number_key in tags_dict else coerce_number(existing_number)
    total = coerce_number(tags_dict[total_key]) if total_key in tags_dict else coerce_number(existing_total)
    return number, total


def write_vorbis_tags(audio, tags_dict):
    """寫入 FLAC / Ogg Vorbis 的 Vorbis comment（鍵名不分大小寫）。"""
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags

    for key, value in _effective_items(tags_dict):
        if key in NUMBER_KEYS:
            number = coerce_number(value)
            values = [number] if number else []
        else:
            values = to_values(key, value)

        for alias in set(TAG_ALIASES.get(key, [])) | {key}:
            try:
                if alias in tags:
                    del tags[alias]
            except ValueError:
                # 非 ASCII 的別名（MP4 atom 名）不是合法的 Vorbis 鍵
                pass
        if values:
            tags[key.upper()] = values


def write_mp4_tags(audio, tags_dict):
    """寫入 MP4 格式的標籤"""
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags

    tag_mapping = {
        'title': '\xa9nam',
        'artist': '\xa9ART',
        'album': '\xa9alb',
        'albumartist': 'aART',
        'composer': '\xa9wrt',
        'performer': '\xa9prf',
        'date': '\xa9day',
        'year': '\xa9day',
        'genre': '\xa9gen',
        'comment': '\xa9cmt',
        'lyrics': '\xa9lyr',
        'titlesort': 'sonm',
        'artistsort': 'soar',
        'albumsort': 'soal',
        'albumartistsort': 'soaa',
        'composersort': 'soco',
        'performersort': 'sope',
    }
    freeform_mapping = {
        'language': '----:com.apple.iTunes:LANGUAGE',
        'favorite': '----:com.apple.iTunes:FAVORITE',
        'replaygain_track_gain': '----:com.apple.iTunes:replaygain_track_gain',
        'replaygain_track_peak': '----:com.apple.iTunes:replaygain_track_peak',
        'replaygain_album_gain': '----:com.apple.iTunes:replaygain_album_gain',
        'replaygain_album_peak': '----:com.apple.iTunes:replaygain_album_peak',
    }

    # disc / track：MP4 的 disk 與 trkn 同為 (num, total) 元組
    for number_key, total_key, _, atom in NUMBER_PAIRS:
        if number_key not in tags_dict and total_key not in tags_dict:
            continue
        existing = (tags.get(atom) or [(0, 0)])[0]
        number, total = _resolve_pair(tags_dict, number_key, total_key, existing[0] or '', existing[1] or '')
        if number or total:
            tags[atom] = [(int(number or 0), int(total or 0))]
        else:
            tags.pop(atom, None)

    for key, value in _effective_items(tags_dict):
        if key in NUMBER_KEYS:
            continue
        if key in freeform_mapping:
            atom = freeform_mapping[key]
        elif key in tag_mapping:
            atom = tag_mapping[key]
        else:
            continue
        values = to_values(key, value)

        for alias in set(TAG_ALIASES.get(key, [])) | {atom}:
            tags.pop(alias, None)
        if values:
            if key in freeform_mapping:
                tags[atom] = [MP4FreeForm(v.encode('utf-8')) for v in values]
            else:
                tags[atom] = values


def write_mp3_tags(audio, tags_dict):
    """寫入 MP3 (ID3v2) 格式的標籤"""
    tags = audio.tags

    frame_mapping = {
        'title': TIT2,
        'artist': TPE1,
        'album': TALB,
        'albumartist': TPE2,
        'composer': TCOM,
        'performer': TPE3,
        'date': TDRC,
        'year': TDRC,
        'titlesort': TSOT,
        'artistsort': TSOP,
        'albumsort': TSOA,
        'albumartistsort': TSO2,
        'composersort': TSOC,
        'genre': TCON,
    }
    # 以 TXXX 儲存的欄位：標準鍵 -> TXXX description
    txxx_mapping = {field: field.upper() for field in CUSTOM_FIELDS}
    txxx_mapping['performersort'] = 'PERFORMERSORT'

    # disc / track：ID3 的 TPOS 與 TRCK 同為 "num/total" 格式
    for number_key, total_key, frame, _ in NUMBER_PAIRS:
        if number_key not in tags_dict and total_key not in tags_dict:
            continue
        existing = str(tags[frame.__name__].text[0]) if frame.__name__ in tags and tags[frame.__name__].text else ''
        existing_number, _, existing_total = existing.partition('/')
        number, total = _resolve_pair(tags_dict, number_key, total_key, existing_number, existing_total)
        tags.delall(frame.__name__)
        if number or total:
            text = f"{int(number or 0)}/{int(total)}" if total else str(int(number))
            tags.add(frame(encoding=3, text=text))

    for key, value in _effective_items(tags_dict):
        if key in NUMBER_KEYS:
            continue
        if key not in frame_mapping and key not in txxx_mapping and key not in ('comment', 'lyrics'):
            continue
        values = to_values(key, value)

        for alias in TAG_ALIASES.get(key, []):
            if alias in tags:
                del tags[alias]
        if key == 'lyrics':
            # 讀取端會退回任意語言/描述的 USLT，必須全部清掉，否則舊歌詞會復活
            tags.delall('USLT')
        elif key in frame_mapping:
            tags.delall(frame_mapping[key].__name__)
        elif key in txxx_mapping:
            tags.delall(f'TXXX:{txxx_mapping[key]}')
        else:
            tags.delall('COMM::eng')

        if not values:
            continue
        if key == 'lyrics':
            tags.add(USLT(encoding=3, lang='eng', desc='', text=values[0]))
        elif key == 'comment':
            tags.add(COMM(encoding=3, lang='eng', desc='', text=values[0]))
        elif key in frame_mapping:
            tags.add(frame_mapping[key](encoding=3, text=values))
        else:
            tags.add(TXXX(encoding=3, desc=txxx_mapping[key], text=values))
            if key == 'language':
                # Navidrome 只讀標準的 TLAN；音樂庫既有 MP3 兩者同值，維持一致
                tags.add(TLAN(encoding=3, text=values))


def write_tags(audio_path, tags_dict) -> bool:
    """修改音訊檔案的標籤

    Args:
        audio_path (str): 音訊檔案路徑
        tags_dict (dict): 要寫入的標籤字典；空值代表刪除該欄位，未提供的欄位不變

    Returns:
        bool: 是否成功寫入標籤
    """
    try:
        logger.info(f"開始寫入音訊檔案標籤: {audio_path}")

        audio = mutagen.File(audio_path)

        if audio is None:
            logger.error(f"無法讀取檔案: {audio_path}")
            return False

        if isinstance(audio, MP4):
            logger.info(f"檔案類型: MP4 - {audio_path}")
            write_mp4_tags(audio, tags_dict)

        elif isinstance(audio, (FLAC, OggVorbis)):
            logger.info(f"檔案類型: {type(audio).__name__} - {audio_path}")
            write_vorbis_tags(audio, tags_dict)

        elif isinstance(audio, MP3):
            logger.info(f"檔案類型: MP3 - {audio_path}")
            if audio.tags is None:
                audio.add_tags()
            write_mp3_tags(audio, tags_dict)

        else:
            logger.warning(f"不支援的檔案格式: {audio_path}")
            return False

        audio.save()
        logger.info(f"成功寫入標籤: {audio_path}")
        return True

    except Exception as e:
        logger.error(f"寫入標籤時發生錯誤: {audio_path} - {str(e)}")
        return False
