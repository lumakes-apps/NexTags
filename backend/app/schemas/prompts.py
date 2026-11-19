from pydantic import BaseModel, ConfigDict, Field, field_validator


MAX_PROMPT_LENGTH = 20_000
MAX_LYRIC_LENGTH = 100_000


class PromptContent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(strict=True, min_length=1, max_length=MAX_PROMPT_LENGTH)

    @field_validator("text")
    @classmethod
    def non_blank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("提示詞不可為空白")
        return value


class PromptUpdate(PromptContent):
    expected_revision: int = Field(strict=True, ge=1)


class PromptPreview(PromptContent):
    lyric: str = Field(strict=True, min_length=1, max_length=MAX_LYRIC_LENGTH)

    @field_validator("lyric")
    @classmethod
    def non_blank_lyric(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("請輸入測試歌詞")
        return value


class LyricsPromptResponse(BaseModel):
    text: str
    default_text: str
    revision: int
    updated_at: str
