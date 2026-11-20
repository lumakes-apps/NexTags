import asyncio
from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.integrations import INTEGRATIONS, navidrome
from app.integrations.navidrome_integration import NavidromeError
from app.services.secret_store import SecretStoreError

router = APIRouter(prefix="/integrations", tags=["integrations"])


class IntegrationUpdate(BaseModel):
    enabled: Optional[bool] = None
    settings: Optional[Dict[str, Any]] = None
    # 密鑰只能寫入：給值為更新，給 null 或空字串為清除；未列出的欄位不變
    secrets: Optional[Dict[str, Optional[str]]] = None


class SyncRequest(BaseModel):
    # 初次同步或剛切換同步方式後，需在預覽後明確確認
    confirm: bool = False


def _get(key: str):
    integration = INTEGRATIONS.get(key)
    if integration is None:
        raise HTTPException(status_code=404, detail="找不到這個整合")
    return integration


async def _run(func, *args):
    try:
        return await asyncio.get_event_loop().run_in_executor(None, func, *args)
    except (ValueError, SecretStoreError, NavidromeError, httpx.HTTPError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.get("")
@router.get("/")
async def list_integrations():
    """所有整合的設定與狀態（密鑰只標示是否已設定，不回傳內容）"""
    return await _run(lambda: [integration.describe() for integration in INTEGRATIONS.values()])


@router.put("/{key}")
async def update_integration(key: str, update: IntegrationUpdate):
    integration = _get(key)
    await _run(integration.save, update.enabled, update.settings, update.secrets)
    return await _run(integration.describe)


@router.post("/{key}/test")
async def test_integration(key: str):
    return await _run(_get(key).test)


@router.post("/navidrome/favorites/preview")
async def preview_favorites_sync():
    """依目前的同步方式比較兩邊的最愛，列出差異與同步後會做的變更（不做任何修改）"""
    return await _run(navidrome.preview)


@router.post("/navidrome/favorites/sync")
async def run_favorites_sync(request: SyncRequest):
    """立即同步最愛；尚未確認過（初次或剛切換同步方式）時需 confirm=true"""
    if not navidrome.is_enabled():
        raise HTTPException(status_code=400, detail="Navidrome 整合未啟用")
    return await _run(navidrome.sync, request.confirm)
