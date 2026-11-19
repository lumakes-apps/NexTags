from fastapi import APIRouter, HTTPException

from app.dependencies.logger import logger
from app.dependencies.lrc_process import lrc_process
from app.schemas.prompts import LyricsPromptResponse, PromptPreview, PromptUpdate
from app.schemas.tools import LyricPressResponse
from app.services.prompt_service import get_lyrics_prompt, save_lyrics_prompt


router = APIRouter(prefix="/prompts", tags=["prompts"])


@router.get("/lyrics", response_model=LyricsPromptResponse)
def read_lyrics_prompt():
    return get_lyrics_prompt()


@router.put("/lyrics", response_model=LyricsPromptResponse)
def update_lyrics_prompt(update: PromptUpdate):
    return save_lyrics_prompt(update)


@router.post("/lyrics/preview", response_model=LyricPressResponse)
def preview_lyrics_prompt(request: PromptPreview):
    try:
        return LyricPressResponse(result=lrc_process(request.lyric, prompt_text=request.text))
    except Exception:
        logger.exception("AI 歌詞提示詞試跑失敗")
        raise HTTPException(status_code=502, detail="AI 試跑失敗，請稍後重試；提示詞未儲存")
