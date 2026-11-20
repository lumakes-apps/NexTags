"""編輯標籤後的檔案移動：先寫標籤、等 Navidrome 掃描過，再搬檔案。

未啟用 Navidrome 整合（或關閉「移動前等待掃描」）時，排入後立即搬移。

Navidrome 以「專輯 + 碟片 + 曲目編號 + 標題」識別歌曲，不含路徑。若標籤改變與檔案搬移
落在同一次掃描，Navidrome 會把它當成刪除再新增，播放次數、喜愛與評分就會遺失。
因此標籤寫入後先排隊，等主機上的 refresh hook 回報「涵蓋這次寫入的掃描已完成」才搬移；
搬移時標籤不變，Navidrome 能依識別碼認出同一首歌。
"""
import json
import os
import shutil
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.dependencies.logger import logger
from app.dependencies.redis_cache import redis_cache

PENDING_MOVES_HASH = 'pending_moves'
AUDIO_EXTENSIONS = {'.flac', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.wma'}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_time(value: Any) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _client():
    if redis_cache is None:
        raise RuntimeError('Redis 無法使用，無法排程檔案移動')
    return redis_cache.client


def queue_move(source: str, target: str) -> Dict[str, Any]:
    """排入一筆移動；同一首歌重複排入時以新的目標取代，並重新等待一次掃描。"""
    entry = {'source': source, 'target': target, 'created_at': _now(), 'status': 'pending', 'error': None}
    _client().hset(PENDING_MOVES_HASH, source, json.dumps(entry, ensure_ascii=False))
    from app.integrations import emit_event
    emit_event('pending_move', {'source': source, 'target': target})
    return entry


def cancel_move(source: str) -> bool:
    return bool(_client().hdel(PENDING_MOVES_HASH, source))


def get_move(source: str) -> Optional[Dict[str, Any]]:
    value = _client().hget(PENDING_MOVES_HASH, source)
    return json.loads(value) if value else None


def list_moves() -> List[Dict[str, Any]]:
    return [json.loads(value) for value in _client().hvals(PENDING_MOVES_HASH)]


def scan_covers(entry: Dict[str, Any], status: Optional[Dict[str, Any]]) -> bool:
    """狀態檔表示：一次在這筆移動排入之後才發出的掃描請求，已經成功掃描完成。"""
    if not status or not status.get('ok'):
        return False
    requested = _parse_time(status.get('request_requested_at'))
    created = _parse_time(entry.get('created_at'))
    return requested is not None and created is not None and requested >= created


def _has_audio(folder: str) -> bool:
    for _, _, files in os.walk(folder):
        if any(os.path.splitext(name)[1].lower() in AUDIO_EXTENSIONS for name in files):
            return True
    return False


def _carry_leftovers(old_dir: str, new_dir: str) -> None:
    """舊資料夾已沒有任何音檔時，把剩下的檔案（cover.jpg、artist.jpg 等）帶到新資料夾，再移除空資料夾。

    新資料夾已有同名檔案時保留新資料夾的版本，舊檔留在原處，不會覆蓋。
    """
    if old_dir == new_dir or not os.path.isdir(old_dir) or _has_audio(old_dir):
        return
    for name in os.listdir(old_dir):
        source = os.path.join(old_dir, name)
        if os.path.isfile(source) and not os.path.exists(os.path.join(new_dir, name)):
            shutil.move(source, os.path.join(new_dir, name))
    try:
        os.rmdir(old_dir)
    except OSError:
        pass  # 仍有無法帶走的檔案，保留資料夾


def perform_move(source: str, target: str) -> None:
    """搬移檔案並同步快取、加入時間與殘留檔案。失敗時拋出例外，不覆蓋任何既有檔案。"""
    if not os.path.isfile(source):
        raise FileNotFoundError(f'原檔案不存在：{source}')
    if os.path.exists(target):
        raise FileExistsError(f'目標位置已有檔案：{target}')

    old_album_dir, new_album_dir = os.path.dirname(source), os.path.dirname(target)
    old_artist_dir, new_artist_dir = os.path.dirname(old_album_dir), os.path.dirname(new_album_dir)
    os.makedirs(new_album_dir, exist_ok=True)
    shutil.move(source, target)

    if redis_cache is not None:
        client = redis_cache.client
        added = client.hget(redis_cache.ADDED_TIME_HASH, source)
        if added is not None:
            client.hset(redis_cache.ADDED_TIME_HASH, target, added)
            client.hdel(redis_cache.ADDED_TIME_HASH, source)
        redis_cache.remove_tags(source)
        redis_cache.upsert_audio_record(target)

    _carry_leftovers(old_album_dir, new_album_dir)
    if old_artist_dir != new_artist_dir and os.path.isdir(old_artist_dir) and not any(
        os.path.isdir(os.path.join(old_artist_dir, name)) for name in os.listdir(old_artist_dir)
    ):
        _carry_leftovers(old_artist_dir, new_artist_dir)
    logger.info(f'已移動檔案: {source} -> {target}')
    from app.integrations import emit_event
    emit_event('file_moved', {'source': source, 'target': target})


def process_pending_moves() -> int:
    """執行所有已等到 Navidrome 掃描的移動；回傳成功移動的數量。"""
    if redis_cache is None:
        return 0
    from app.integrations import navidrome
    wait = navidrome.wait_for_scan()
    status = navidrome.scan_status() if wait else None
    moved = 0
    for entry in list_moves():
        if entry.get('status') != 'pending' or (wait and not scan_covers(entry, status)):
            continue
        source, target = entry['source'], entry['target']
        try:
            perform_move(source, target)
            cancel_move(source)
            moved += 1
        except Exception as error:
            logger.error(f'檔案移動失敗 {source} -> {target}: {error}')
            entry.update(status='failed', error=str(error))
            _client().hset(PENDING_MOVES_HASH, source, json.dumps(entry, ensure_ascii=False))

    if moved:
        # 路徑改變後重新產生 M3U，並再掃描一次；這次標籤沒變，Navidrome 會沿用原本的歌曲紀錄
        try:
            from app.router.playlists import regenerate_all_m3u
            regenerate_all_m3u()
        except Exception as error:
            logger.error(f'移動後重新產生 M3U 失敗: {error}')
        from app.integrations import emit_event
        emit_event('pending_moves_done', {'moved': moved})
    return moved


async def run_worker(interval_seconds: float = 10) -> None:
    """定期檢查排隊中的移動；阻塞的檔案操作交給執行緒池。"""
    import asyncio
    loop = asyncio.get_running_loop()
    while True:
        try:
            await loop.run_in_executor(None, process_pending_moves)
        except Exception as error:
            logger.error(f'處理待移動檔案時發生錯誤: {error}')
        await asyncio.sleep(interval_seconds)
