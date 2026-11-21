"""匯入精靈的進度（每個上傳的檔案一筆）。

存在 Redis，backend 重啟或部署後仍能從快取頁或新增歌曲頁接續；未完成的進度一直保留到
使用者刪除或匯入完成，已完成或失敗的保留 6 小時供查看。Redis 無法使用時退回行程內記憶體
（重啟即消失，與過去的行為相同）。

讀取一律回傳副本：修改後要用 save / update 寫回，避免改了物件卻沒有存到 Redis。
"""
import copy
import json
from datetime import datetime
from enum import Enum
from typing import Any, Dict, Iterator, Optional

from pydantic import BaseModel

from app.dependencies import redis_cache as redis_cache_module
from app.dependencies.logger import logger

KEY_PREFIX = 'music_import:session:'
INDEX_KEY = 'music_import:sessions'
FINISHED_TTL_SECONDS = 6 * 60 * 60
TERMINAL_STATUSES = {'completed', 'failed'}


def _default(value: Any):
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, BaseModel):
        return value.model_dump()
    raise TypeError(f'無法儲存的匯入資料型別: {type(value).__name__}')


def _status_value(session: Dict[str, Any]) -> str:
    status = session.get('status')
    return status.value if isinstance(status, Enum) else str(status or '')


class ImportSessionStore:
    def __init__(self):
        self._memory: Dict[str, str] = {}

    def _client(self):
        cache = redis_cache_module.redis_cache
        return cache.client if cache is not None else None

    # ---- 基本讀寫 ----

    def get(self, file_id: str, default=None) -> Optional[Dict[str, Any]]:
        client = self._client()
        raw = client.get(KEY_PREFIX + file_id) if client is not None else self._memory.get(file_id)
        if raw is None:
            return default
        return json.loads(raw)

    def save(self, file_id: str, session: Dict[str, Any]) -> None:
        raw = json.dumps(session, ensure_ascii=False, default=_default)
        client = self._client()
        if client is None:
            self._memory[file_id] = raw
            return
        ttl = FINISHED_TTL_SECONDS if _status_value(session) in TERMINAL_STATUSES else None
        pipe = client.pipeline()
        pipe.set(KEY_PREFIX + file_id, raw, ex=ttl)
        pipe.sadd(INDEX_KEY, file_id)
        pipe.execute()

    def delete(self, file_id: str) -> bool:
        client = self._client()
        if client is None:
            return self._memory.pop(file_id, None) is not None
        pipe = client.pipeline()
        pipe.delete(KEY_PREFIX + file_id)
        pipe.srem(INDEX_KEY, file_id)
        deleted, _ = pipe.execute()
        return bool(deleted)

    def update(self, file_id: str, **fields: Any) -> Dict[str, Any]:
        """合併欄位並更新 updated_at；不存在時建立。"""
        session = self.get(file_id) or {'created_at': datetime.now(), 'errors': []}
        session.update(fields)
        session['updated_at'] = datetime.now()
        self.save(file_id, session)
        return session

    def add_error(self, file_id: str, message: str) -> None:
        session = self.get(file_id)
        if session is None:
            return
        session.setdefault('errors', []).append(message)
        self.save(file_id, session)

    def all(self) -> Dict[str, Dict[str, Any]]:
        client = self._client()
        if client is None:
            return {file_id: json.loads(raw) for file_id, raw in self._memory.items()}
        ids = sorted(client.smembers(INDEX_KEY))
        ids = [i.decode() if isinstance(i, bytes) else i for i in ids]
        if not ids:
            return {}
        values = client.mget([KEY_PREFIX + i for i in ids])
        sessions, expired = {}, []
        for file_id, raw in zip(ids, values):
            if raw is None:
                expired.append(file_id)  # 已完成的進度過期後，從索引移除
            else:
                sessions[file_id] = json.loads(raw)
        if expired:
            client.srem(INDEX_KEY, *expired)
        return sessions

    # ---- 讓舊程式碼可以像字典一樣讀取 ----

    def __contains__(self, file_id: object) -> bool:
        return isinstance(file_id, str) and self.get(file_id) is not None

    def __getitem__(self, file_id: str) -> Dict[str, Any]:
        session = self.get(file_id)
        if session is None:
            raise KeyError(file_id)
        return session

    def __setitem__(self, file_id: str, session: Dict[str, Any]) -> None:
        self.save(file_id, copy.deepcopy(session))

    def __delitem__(self, file_id: str) -> None:
        if not self.delete(file_id):
            raise KeyError(file_id)

    def pop(self, file_id: str, default=None):
        session = self.get(file_id)
        if session is None:
            return default
        self.delete(file_id)
        return session

    def keys(self) -> Iterator[str]:
        return iter(self.all().keys())


import_sessions = ImportSessionStore()


if redis_cache_module.redis_cache is None:
    logger.warning('Redis 無法使用：匯入進度只存在記憶體，backend 重啟後無法接續')
