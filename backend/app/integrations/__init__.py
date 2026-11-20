"""可開關的外部整合。核心只發出事件，由已啟用的整合決定如何處理。"""
from typing import Any, Dict, Optional

from app.dependencies.logger import logger
from app.integrations.ai_lyrics_integration import AiLyricsIntegration
from app.integrations.base import Integration
from app.integrations.navidrome_integration import NavidromeIntegration

navidrome = NavidromeIntegration()
ai_lyrics = AiLyricsIntegration()
INTEGRATIONS: Dict[str, Integration] = {i.key: i for i in (navidrome, ai_lyrics)}


def emit_event(event: str, payload: Optional[Dict[str, Any]] = None) -> None:
    """通知所有已啟用的整合；單一整合失敗不影響核心流程與其他整合。"""
    for integration in INTEGRATIONS.values():
        try:
            if integration.is_enabled():
                integration.handle(event, payload or {})
        except Exception as error:
            logger.warning(f'整合 {integration.key} 處理事件 {event} 失敗: {error}')
