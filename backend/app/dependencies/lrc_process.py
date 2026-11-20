from anthropic import Anthropic
from app.dependencies.logger import logger
from app.services.prompt_service import get_lyrics_prompt


def call_anthropic_api(prompts):
    """呼叫 Anthropic API；金鑰在每次呼叫時由整合設定讀取（未啟用或未設定時拋出 ValueError）"""
    from app.integrations import ai_lyrics
    client = Anthropic(api_key=ai_lyrics.api_key())
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        temperature=0,
        messages=prompts,
    )
    if message.stop_reason == "max_tokens":
        raise RuntimeError("歌詞結果超出輸出長度限制，請縮短歌詞後重試")
    return message.content[0].text


def log_lrc_preview(lrc_text, prefix=""):
    """記錄歌詞預覽"""
    preview_lines = lrc_text.split("\n")[0:3]
    logger.info(f"{prefix}{preview_lines}")


def lrc_process(lrc: str, prompt_text: str | None = None) -> str:
    """處理歌詞文本"""
    print("正在處理歌詞文本")
    
    if not lrc:
        return ""

    if prompt_text is None:
        prompt_text = get_lyrics_prompt()["text"]
    prompts = [
        {"role": "user", "content": prompt_text},
        {"role": "user", "content": lrc},
    ]
    
    log_lrc_preview(lrc)
    
    processed_content = call_anthropic_api(prompts)
    
    log_lrc_preview(processed_content)
    
    return processed_content
