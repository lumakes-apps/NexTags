"""AI 歌詞整理（Anthropic Claude）。沒有金鑰或關閉時，編輯器不顯示整理按鈕。"""
from typing import Any, Dict

from app.integrations.base import Field, Integration


class AiLyricsIntegration(Integration):
    def __init__(self):
        super().__init__(
            key='ai_lyrics',
            name='AI 歌詞整理',
            description='使用 Anthropic Claude 統一 LRC 時間格式、簡轉繁並加上中文翻譯。整理規則可在下方的提示詞修改。',
            enabled_by_default=True,  # 維持既有部署的行為；沒有金鑰時視為不可用
            fields=[Field('api_key', 'Anthropic API 金鑰', 'secret', help='也可用環境變數 ANTHROPIC_TOKEN 提供', group='金鑰')],
        )

    def available(self) -> bool:
        return bool(self.secret('api_key'))

    def api_key(self) -> str:
        if not self.is_enabled():
            raise ValueError('AI 歌詞整理未啟用，請到設定的「整合」開啟')
        key = self.secret('api_key')
        if not key:
            raise ValueError('尚未設定 Anthropic API 金鑰，請到設定的「整合」填寫')
        return key

    def test(self) -> Dict[str, Any]:
        from anthropic import Anthropic, APIError
        try:
            Anthropic(api_key=self.api_key()).models.list(limit=1)
            return {'ok': True, 'message': '金鑰有效'}
        except (ValueError, APIError) as error:
            return {'ok': False, 'message': str(error)}
