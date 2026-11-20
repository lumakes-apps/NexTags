"""加密儲存整合用的密鑰（Navidrome 密碼、AI 金鑰等）。

主金鑰由環境變數 NEXTAGS_SECRET_KEY 提供（Fernet 金鑰：32 bytes 的 urlsafe base64），
資料庫只存密文。密鑰只能寫入，API 不回傳明文；未設定主金鑰時無法儲存或讀取資料庫中的密鑰。
部分密鑰可由既有的環境變數覆寫（例如 ANTHROPIC_TOKEN），方便從舊設定遷移。
"""
import os
from typing import Dict, Optional

from cryptography.fernet import Fernet, InvalidToken

from app.dependencies import database
from app.dependencies.logger import logger

MASTER_KEY_ENV = 'NEXTAGS_SECRET_KEY'
# 密鑰名稱 -> 可覆寫它的環境變數
ENV_OVERRIDES: Dict[str, str] = {'ai_lyrics.api_key': 'ANTHROPIC_TOKEN'}


class SecretStoreError(RuntimeError):
    pass


def _fernet() -> Fernet:
    key = os.getenv(MASTER_KEY_ENV, '').strip()
    if not key:
        raise SecretStoreError(f'未設定 {MASTER_KEY_ENV}，無法儲存密鑰')
    try:
        return Fernet(key.encode())
    except ValueError as error:
        raise SecretStoreError(f'{MASTER_KEY_ENV} 格式不正確，需為 Fernet 金鑰（32 bytes 的 urlsafe base64）') from error


def master_key_configured() -> bool:
    try:
        _fernet()
        return True
    except SecretStoreError:
        return False


def _connection():
    if database.db is None:
        raise SecretStoreError('資料庫未初始化')
    return database.db.get_connection()


def _ensure_table(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS Secrets (
            name TEXT PRIMARY KEY,
            ciphertext TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
    """)


def set_secret(name: str, value: str) -> None:
    token = _fernet().encrypt(value.encode()).decode()
    with _connection() as conn:
        _ensure_table(conn)
        conn.execute("""
            INSERT INTO Secrets (name, ciphertext) VALUES (?, ?)
            ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        """, (name, token))
        conn.commit()


def delete_secret(name: str) -> None:
    with _connection() as conn:
        _ensure_table(conn)
        conn.execute('DELETE FROM Secrets WHERE name = ?', (name,))
        conn.commit()


def _stored_ciphertext(name: str) -> Optional[str]:
    with _connection() as conn:
        _ensure_table(conn)
        row = conn.execute('SELECT ciphertext FROM Secrets WHERE name = ?', (name,)).fetchone()
    return row['ciphertext'] if row else None


def get_secret(name: str) -> Optional[str]:
    """取得明文：環境變數覆寫優先，其次為資料庫；都沒有時回傳 None。"""
    env_name = ENV_OVERRIDES.get(name)
    if env_name and os.getenv(env_name):
        return os.getenv(env_name)
    try:
        token = _stored_ciphertext(name)
        if token is None:
            return None
        return _fernet().decrypt(token.encode()).decode()
    except SecretStoreError as error:
        logger.warning(f'無法讀取密鑰 {name}: {error}')
        return None
    except InvalidToken:
        logger.error(f'密鑰 {name} 無法解密：{MASTER_KEY_ENV} 可能已更換，請重新輸入')
        return None


def secret_source(name: str) -> Optional[str]:
    """密鑰來源：'env'、'database' 或 None（未設定）。不回傳任何密鑰內容。"""
    env_name = ENV_OVERRIDES.get(name)
    if env_name and os.getenv(env_name):
        return 'env'
    try:
        return 'database' if _stored_ciphertext(name) is not None else None
    except SecretStoreError:
        return None
