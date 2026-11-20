"""整合（integration）的共用介面。

核心程式只發出事件（emit_event），不直接呼叫外部服務；各整合依自己的設定決定是否處理。
整合關閉時，核心功能照常運作，只是不會與該外部服務互動。
"""
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from app.dependencies.logger import logger
from app.services import secret_store


@dataclass
class Field:
    name: str
    label: str
    kind: str  # text | url | number | bool | select | secret
    default: Any = None
    help: str = ''
    # select 的選項：[[值, 顯示文字], ...]
    options: List[List[str]] = field(default_factory=list)
    # 設定頁中的區塊名稱，同區塊的欄位放在一起
    group: str = '設定'


@dataclass
class Integration:
    key: str
    name: str
    description: str
    fields: List[Field] = field(default_factory=list)
    enabled_by_default: bool = False

    # ---- 設定 ----
    @property
    def config_key(self) -> str:
        return f'integration:{self.key}'

    def _stored(self) -> Dict[str, Any]:
        from app.router.config import get_config
        try:
            return get_config(self.config_key) or {}
        except Exception as error:  # 資料庫未就緒時視為未設定
            logger.warning(f'讀取整合設定失敗 {self.key}: {error}')
            return {}

    def is_enabled(self) -> bool:
        return bool(self._stored().get('enabled', self.enabled_by_default))

    def settings(self) -> Dict[str, Any]:
        stored = self._stored().get('settings', {})
        return {f.name: stored.get(f.name, f.default) for f in self.fields if f.kind != 'secret'}

    def secret(self, name: str) -> Optional[str]:
        return secret_store.get_secret(f'{self.key}.{name}')

    def save(self, enabled: Optional[bool] = None, settings: Optional[Dict[str, Any]] = None,
             secrets: Optional[Dict[str, Optional[str]]] = None) -> None:
        from app.router.config import set_config
        known = {f.name: f for f in self.fields}
        for name, value in (secrets or {}).items():
            if name not in known or known[name].kind != 'secret':
                raise ValueError(f'未知的密鑰欄位：{name}')
            if value is None or value == '':
                secret_store.delete_secret(f'{self.key}.{name}')
            else:
                secret_store.set_secret(f'{self.key}.{name}', value)
        stored = self._stored()
        merged = {**stored.get('settings', {})}
        for name, value in (settings or {}).items():
            if name not in known or known[name].kind == 'secret':
                raise ValueError(f'未知的設定欄位：{name}')
            if known[name].kind == 'select' and value not in [option[0] for option in known[name].options]:
                raise ValueError(f'{known[name].label} 的值無效：{value}')
            merged[name] = value
        set_config(self.config_key, {
            'enabled': stored.get('enabled', self.enabled_by_default) if enabled is None else bool(enabled),
            'settings': merged,
        }, f'{self.name} 整合設定')

    def describe(self) -> Dict[str, Any]:
        """給前端的設定描述：只標示密鑰是否已設定與來源，不含任何密鑰內容。"""
        return {
            'key': self.key,
            'name': self.name,
            'description': self.description,
            'enabled': self.is_enabled(),
            'available': self.is_enabled() and self.available(),
            'fields': [asdict(f) for f in self.fields],
            'settings': self.settings(),
            'secrets': {f.name: secret_store.secret_source(f'{self.key}.{f.name}')
                        for f in self.fields if f.kind == 'secret'},
            'master_key_configured': secret_store.master_key_configured(),
            'status': self.status() if self.is_enabled() else {},
        }

    # ---- 子類別覆寫 ----
    def available(self) -> bool:
        """設定齊全、可以實際使用。"""
        return True

    def status(self) -> Dict[str, Any]:
        return {}

    def test(self) -> Dict[str, Any]:
        return {'ok': True, 'message': '無需測試'}

    def handle(self, event: str, payload: Dict[str, Any]) -> None:
        pass
