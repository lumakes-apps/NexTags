"""AI 歌詞提示詞的持久化；每次讀取 SQLite，避免跨 worker 快取延遲。"""
import json
from pathlib import Path

from fastapi import HTTPException

from app.dependencies import database
from app.schemas.prompts import PromptUpdate


PROMPT_KEY = "ai_lyrics_prompt"
DEFAULT_PROMPT_PATH = Path(__file__).resolve().parents[1] / "prompts" / "lyrics_cleanup.txt"


def default_lyrics_prompt() -> str:
    return DEFAULT_PROMPT_PATH.read_text(encoding="utf-8")


def _database():
    if database.db is None:
        raise HTTPException(status_code=503, detail="提示詞資料庫未初始化")
    return database.db


def initialize_lyrics_prompt():
    """只為尚未有提示詞的資料庫建立預設值，保留所有既有自訂內容。"""
    value = json.dumps({"text": default_lyrics_prompt(), "revision": 1}, ensure_ascii=False)
    with _database().get_connection() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO Config (config_key, config_value, description, updated_at)
               VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""",
            (PROMPT_KEY, value, "AI 歌詞整理提示詞"),
        )
        conn.commit()


def _read_prompt(conn):
    row = conn.execute(
        "SELECT config_value, updated_at FROM Config WHERE config_key = ?", (PROMPT_KEY,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=503, detail="歌詞提示詞尚未初始化，請重新啟動服務")
    value = json.loads(row["config_value"])
    return {**value, "updated_at": row["updated_at"], "default_text": default_lyrics_prompt()}


def get_lyrics_prompt():
    with _database().get_connection() as conn:
        return _read_prompt(conn)


def save_lyrics_prompt(update: PromptUpdate):
    with _database().get_connection() as conn:
        # 在取得寫入鎖後才檢查 revision，避免兩個 worker 同時覆寫。
        conn.execute("BEGIN IMMEDIATE")
        current = _read_prompt(conn)
        if current["revision"] != update.expected_revision:
            raise HTTPException(status_code=409, detail="提示詞已被更新，請先載入最新版本再儲存；草稿仍保留")
        value = json.dumps(
            {"text": update.text, "revision": current["revision"] + 1}, ensure_ascii=False
        )
        conn.execute(
            """UPDATE Config SET config_value = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE config_key = ?""",
            (value, PROMPT_KEY),
        )
        result = _read_prompt(conn)
        conn.commit()
    return result
