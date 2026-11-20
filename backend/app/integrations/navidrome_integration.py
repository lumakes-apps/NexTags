"""Navidrome 整合：掃描通知、檔案移動前等待掃描、最愛同步。"""
import asyncio
import hashlib
import json
import os
import secrets
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set

import httpx

from app.dependencies.logger import logger
from app.dependencies.navidrome_hook import request_navidrome_refresh
from app.integrations.base import Field, Integration

# 這些事件會觸發主機上的 refresh hook（沿用原本的原因名稱，hook 紀錄可延續）
REFRESH_EVENTS = {
    'audio_cover_update', 'music_import_confirm_move', 'playlist_generate_m3u',
    'playlist_batch_generate_m3u', 'pending_move', 'pending_moves_done',
}
STATUS_FILE = os.getenv('NAVIDROME_HOOK_STATUS_FILE', '/app/data/navidrome_status/status.json')
MUSIC_ROOT = '/Music'

FAV_SNAPSHOT = 'favsync:snapshot'      # 上次同步後雙方一致的最愛路徑
FAV_INITIALIZED = 'favsync:initialized'
FAV_STATUS = 'favsync:status'
FAV_DIRTY = 'favsync:dirty'
FAV_LOCK = 'favsync:lock'
STRATEGIES = {'union', 'local', 'remote'}


class NavidromeError(RuntimeError):
    pass


class NavidromeClient:
    """原生 API 取得真實路徑（Subsonic 預設回傳的是組合出的假路徑）；喜愛的寫入用 Subsonic star/unstar。"""

    def __init__(self, base_url: str, username: str, password: str, timeout: float = 30):
        if not (base_url and username and password):
            raise NavidromeError('請先設定 Navidrome 網址、帳號與密碼')
        self.base_url = base_url.rstrip('/')
        self.username, self.password = username, password
        self.http = httpx.Client(timeout=timeout)
        self._token: Optional[str] = None

    def close(self):
        self.http.close()

    def _native_headers(self) -> Dict[str, str]:
        if self._token is None:
            response = self.http.post(f'{self.base_url}/auth/login',
                                      json={'username': self.username, 'password': self.password})
            if response.status_code != 200:
                raise NavidromeError(f'Navidrome 登入失敗（HTTP {response.status_code}）')
            self._token = response.json()['token']
        return {'x-nd-authorization': f'Bearer {self._token}'}

    def _subsonic(self, endpoint: str, params: List[tuple]) -> Dict[str, Any]:
        salt = secrets.token_hex(6)
        token = hashlib.md5((self.password + salt).encode()).hexdigest()
        auth = [('u', self.username), ('t', token), ('s', salt), ('v', '1.16.1'), ('c', 'nextags'), ('f', 'json')]
        response = self.http.get(f'{self.base_url}/rest/{endpoint}', params=auth + params)
        body = response.json().get('subsonic-response', {})
        if response.status_code != 200 or body.get('status') != 'ok':
            raise NavidromeError(f"Navidrome {endpoint} 失敗：{body.get('error', {}).get('message', response.status_code)}")
        return body

    def ping(self) -> str:
        self._native_headers()
        return self._subsonic('ping', []).get('serverVersion', '')

    def songs(self, page_size: int = 500) -> List[Dict[str, Any]]:
        result, start = [], 0
        while True:
            response = self.http.get(f'{self.base_url}/api/song', headers=self._native_headers(),
                                     params={'_start': start, '_end': start + page_size})
            if response.status_code != 200:
                raise NavidromeError(f'讀取 Navidrome 歌曲失敗（HTTP {response.status_code}）')
            page = response.json()
            result.extend(page)
            total = int(response.headers.get('x-total-count', len(result)))
            start += page_size
            if not page or start >= total:
                return result

    def set_starred(self, ids: Iterable[str], starred: bool, batch: int = 50) -> None:
        ids = list(ids)
        for i in range(0, len(ids), batch):
            self._subsonic('star' if starred else 'unstar', [('id', song_id) for song_id in ids[i:i + batch]])


def song_library_path(song: Dict[str, Any]) -> str:
    """Navidrome 的音樂庫名稱即 NexTags 的資料夾名稱，路徑為相對於該音樂庫。"""
    return os.path.join(MUSIC_ROOT, song.get('libraryName', ''), song.get('path', ''))


def is_favorite(tags: Dict[str, Any]) -> bool:
    value = tags.get('favorite')
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ''
    return str(value or '').strip().lower() in {'true', '1', 'yes'}


def plan_sync(local: Set[str], remote: Set[str], universe: Set[str],
              snapshot: Optional[Set[str]], strategy: str = 'union') -> Dict[str, Set[str]]:
    """三方比對：與上次同步結果相比，哪一邊改了就以哪一邊為準。

    snapshot 為 None 代表尚未同步過，依 strategy 決定：union 兩邊任一為最愛即為最愛，
    local 以 NexTags 為準，remote 以 Navidrome 為準。只處理雙方都有的歌曲（universe）。
    """
    plan = {'star': set(), 'unstar': set(), 'favorite': set(), 'unfavorite': set(), 'final': set()}
    for path in universe:
        in_local, in_remote = path in local, path in remote
        if in_local == in_remote:
            final = in_local
        elif snapshot is None:
            final = {'union': True, 'local': in_local, 'remote': in_remote}[strategy]
        else:
            # 布林值只有兩種：兩邊不同時，恰有一邊與上次結果相同，另一邊就是這次改的
            final = in_local if in_remote == (path in snapshot) else in_remote
        if final != in_local:
            plan['favorite' if final else 'unfavorite'].add(path)
        if final != in_remote:
            plan['star' if final else 'unstar'].add(path)
        if final:
            plan['final'].add(path)
    return plan


class NavidromeIntegration(Integration):
    def __init__(self):
        super().__init__(
            key='navidrome',
            name='Navidrome',
            description='匯入、封面、播放清單與檔案移動後通知 Navidrome 重新掃描；檔案移動等掃描完成再進行以保留播放紀錄；可與 Navidrome 同步最愛。',
            enabled_by_default=True,  # 維持既有部署的行為
            fields=[
                Field('refresh_hook', '變更後通知主機 refresh hook 重新掃描', 'bool', True),
                Field('wait_for_scan', '移動檔案前等待 Navidrome 掃描（保留播放紀錄）', 'bool', True,
                      '需安裝 deploy/navidrome-refresh-hook；未安裝時請關閉，否則檔案會一直等待移動'),
                Field('base_url', 'Navidrome 網址', 'url', '', '例如 http://navidrome:4533，最愛同步需要'),
                Field('username', '帳號', 'text', ''),
                Field('password', '密碼', 'secret'),
                Field('favorites_sync', '同步最愛（NexTags FAVORITE 標籤 ↔ Navidrome 喜愛）', 'bool', False),
                Field('sync_interval_minutes', '定期同步間隔（分鐘）', 'number', 15),
            ],
        )

    # ---- 掃描通知與檔案移動 ----
    def handle(self, event: str, payload: Dict[str, Any]) -> None:
        settings = self.settings()
        if event in REFRESH_EVENTS and settings['refresh_hook']:
            request_navidrome_refresh(event, payload)
        if event == 'tags_saved' and settings['favorites_sync']:
            _redis().set(FAV_DIRTY, '1')
        if event == 'file_moved':
            client = _redis()
            if client.srem(FAV_SNAPSHOT, payload['source']):
                client.sadd(FAV_SNAPSHOT, payload['target'])

    def wait_for_scan(self) -> bool:
        settings = self.settings()
        return self.is_enabled() and settings['refresh_hook'] and settings['wait_for_scan']

    def scan_status(self) -> Optional[Dict[str, Any]]:
        try:
            with open(STATUS_FILE, encoding='utf-8') as handle:
                return json.load(handle)
        except (OSError, ValueError):
            return None

    # ---- 連線 ----
    def client(self) -> NavidromeClient:
        settings = self.settings()
        return NavidromeClient(settings['base_url'], settings['username'], self.secret('password') or '')

    def test(self) -> Dict[str, Any]:
        try:
            client = self.client()
            try:
                return {'ok': True, 'message': f'已連線到 Navidrome {client.ping()}'}
            finally:
                client.close()
        except (NavidromeError, httpx.HTTPError, ValueError) as error:
            return {'ok': False, 'message': str(error)}

    def status(self) -> Dict[str, Any]:
        raw = _redis().get(FAV_STATUS) if _redis_available() else None
        return {
            'scan': self.scan_status(),
            'favorites': {
                'initialized': bool(_redis_available() and _redis().exists(FAV_INITIALIZED)),
                'last': json.loads(raw) if raw else None,
            },
        }

    # ---- 最愛同步 ----
    def _gather(self, client: NavidromeClient):
        from app.dependencies.redis_cache import redis_cache
        if redis_cache is None:
            raise NavidromeError('Redis 無法使用')
        records = redis_cache.get_audio_records()
        local_paths = {r['file_path'] for r in records if r.get('file_path')}
        local_fav = {r['file_path'] for r in records if r.get('file_path') and is_favorite(r.get('tags') or {})}
        songs = client.songs()
        ids = {song_library_path(s): s['id'] for s in songs}
        remote_fav = {song_library_path(s) for s in songs if s.get('starred')}
        universe = local_paths & set(ids)
        return {
            'local': local_fav & universe, 'remote': remote_fav & universe, 'universe': universe, 'ids': ids,
            'remote_only_songs': len(set(ids) - local_paths),
            'local_only_songs': len(local_paths - set(ids)),
        }

    def preview(self, strategy: str = 'union') -> Dict[str, Any]:
        if strategy not in STRATEGIES:
            raise ValueError('未知的同步方式')
        client = self.client()
        try:
            data = self._gather(client)
        finally:
            client.close()
        snapshot = self._snapshot()
        plan = plan_sync(data['local'], data['remote'], data['universe'], snapshot, strategy)
        return {
            'initialized': snapshot is not None,
            'matched_songs': len(data['universe']),
            'local_favorites': len(data['local']),
            'remote_favorites': len(data['remote']),
            'only_local': sorted(data['local'] - data['remote'])[:50],
            'only_remote': sorted(data['remote'] - data['local'])[:50],
            'only_local_count': len(data['local'] - data['remote']),
            'only_remote_count': len(data['remote'] - data['local']),
            'not_in_navidrome': data['local_only_songs'],
            'not_in_nextags': data['remote_only_songs'],
            'plan': {key: len(value) for key, value in plan.items() if key != 'final'},
        }

    def _snapshot(self) -> Optional[Set[str]]:
        client = _redis()
        return set(client.smembers(FAV_SNAPSHOT)) if client.exists(FAV_INITIALIZED) else None

    def sync(self, strategy: Optional[str] = None) -> Dict[str, Any]:
        """執行同步。尚未同步過時必須指定 strategy（初次同步方式）。"""
        from app.dependencies.mp3tag_writer import write_tags
        from app.dependencies.redis_cache import redis_cache
        redis_client = _redis()
        if not redis_client.set(FAV_LOCK, '1', nx=True, ex=600):
            raise NavidromeError('已有同步正在進行')
        started = datetime.now(timezone.utc).isoformat()
        try:
            snapshot = self._snapshot()
            if snapshot is None and strategy not in STRATEGIES:
                raise NavidromeError('尚未同步過，請先選擇初次同步方式')
            client = self.client()
            try:
                data = self._gather(client)
                plan = plan_sync(data['local'], data['remote'], data['universe'], snapshot, strategy or 'union')
                final = set(plan['final'])
                errors: List[str] = []
                for starred, key in ((True, 'star'), (False, 'unstar')):
                    try:
                        client.set_starred([data['ids'][p] for p in plan[key]], starred)
                    except (NavidromeError, httpx.HTTPError) as error:
                        errors.append(str(error))
                        # 失敗的一方維持原狀，下次同步時另一方會被視為「有改動」而重試
                        final = final - plan[key] if starred else final | plan[key]
            finally:
                client.close()
            for favorite, key in ((True, 'favorite'), (False, 'unfavorite')):
                for path in plan[key]:
                    if write_tags(path, {'favorite': 'True' if favorite else 'False'}):
                        redis_cache.upsert_audio_record(path)
                    else:
                        errors.append(f'無法寫入 {path}')
                        final = final - {path} if favorite else final | {path}
            pipe = redis_client.pipeline()
            pipe.delete(FAV_SNAPSHOT)
            if final:
                pipe.sadd(FAV_SNAPSHOT, *final)
            pipe.set(FAV_INITIALIZED, started)
            pipe.delete(FAV_DIRTY)
            pipe.execute()
            result = {'ok': not errors, 'started_at': started, 'finished_at': datetime.now(timezone.utc).isoformat(),
                      'strategy': strategy if snapshot is None else 'incremental',
                      'applied': {key: len(value) for key, value in plan.items() if key != 'final'},
                      'errors': errors[:20]}
        except Exception as error:
            result = {'ok': False, 'started_at': started, 'finished_at': datetime.now(timezone.utc).isoformat(),
                      'error': str(error)}
            redis_client.set(FAV_STATUS, json.dumps(result, ensure_ascii=False))
            raise
        finally:
            redis_client.delete(FAV_LOCK)
        redis_client.set(FAV_STATUS, json.dumps(result, ensure_ascii=False))
        logger.info(f'最愛同步完成: {result.get("applied")}')
        return result

    def sync_due(self) -> bool:
        settings = self.settings()
        if not (self.is_enabled() and settings['favorites_sync'] and _redis_available()):
            return False
        client = _redis()
        if not client.exists(FAV_INITIALIZED):
            return False
        if client.exists(FAV_DIRTY):
            return True
        raw = client.get(FAV_STATUS)
        last = json.loads(raw).get('finished_at') if raw else None
        if not last:
            return True
        elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds()
        return elapsed >= float(settings['sync_interval_minutes'] or 15) * 60

    async def run(self, interval_seconds: float = 30) -> None:
        loop = asyncio.get_running_loop()
        while True:
            try:
                if await loop.run_in_executor(None, self.sync_due):
                    await loop.run_in_executor(None, self.sync)
            except Exception as error:
                logger.error(f'定期最愛同步失敗: {error}')
            await asyncio.sleep(interval_seconds)


def _redis_available() -> bool:
    from app.dependencies.redis_cache import redis_cache
    return redis_cache is not None


def _redis():
    from app.dependencies.redis_cache import redis_cache
    if redis_cache is None:
        raise NavidromeError('Redis 無法使用')
    return redis_cache.client
