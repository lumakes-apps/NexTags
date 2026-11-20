import asyncio
from fastapi import APIRouter, HTTPException
from typing import Dict, List
from pydantic import BaseModel
from app.router.config import get_config
from app.dependencies.artist_index import build_artist_index
from app.dependencies.redis_cache import redis_cache

router = APIRouter(prefix="/tags", tags=["tags"])

# Response models
class BaseFoldersResponse(BaseModel):
    success: bool
    base_folders: List[str]

class ArtistEntry(BaseModel):
    name: str
    sort: str
    roles: Dict[str, int]

@router.get("/tags")
async def get_supported_tags() -> List[str]:
    """獲取支援的標籤清單"""
    try:
        supported_tags = get_config('supported_tags')
        return supported_tags if supported_tags else []
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"讀取標籤清單時發生錯誤: {str(e)}")

@router.get("/languages")
async def get_supported_languages() -> dict:
    """獲取支援的語言清單"""
    try:
        supported_languages = get_config('supported_languages')
        return supported_languages if supported_languages else {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"讀取語言清單時發生錯誤: {str(e)}")

@router.get("/baseFolders")
async def get_base_folders() -> BaseFoldersResponse:
    """獲取允許的基礎資料夾清單"""
    try:
        allow_folders = get_config('allow_folders')
        return BaseFoldersResponse(
            success=True,
            base_folders=allow_folders if allow_folders else []
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"讀取資料夾清單時發生錯誤: {str(e)}")

def _load_artist_index() -> List[dict]:
    if redis_cache is None:
        return []
    return build_artist_index(record.get('tags') or {} for record in redis_cache.get_audio_records())

@router.get("/artists", response_model=List[ArtistEntry])
async def get_artists():
    """音樂庫中所有歌手類欄位（Artist / AlbumArtist / Composer / Performer）的名字，供標籤輸入建議使用"""
    try:
        # 讀取整個 catalog 屬阻塞 I/O，丟到執行緒池
        return await asyncio.get_event_loop().run_in_executor(None, _load_artist_index)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"讀取歌手清單時發生錯誤: {str(e)}")
