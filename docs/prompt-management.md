# AI 歌詞提示詞管理

在「系統設定 → 提示詞管理」編輯 AI 歌詞整理規則，也可直接開啟 `/settings?tab=prompts`。

- 「儲存提示詞」後，下一次一般標籤編輯與匯入編輯的歌詞整理會使用新內容；進行中的請求維持原版本。
- 「試跑」使用目前草稿，會呼叫 AI 並產生費用；不儲存設定或寫入音樂檔。
- 「捨棄修改」回到最近載入的正式內容。「載入預設」只更新草稿，仍需儲存才生效。
- 發生版本衝突時，按「載入最新版本（保留草稿）」取得最新版本，再確認草稿是否適合覆寫。
- 提示詞上限 20,000 字元、測試歌詞上限 100,000 字元；空白輸入會被拒絕。
- 設定匯出格式為 1.1，`ai_lyrics_prompt` 是可選的文字欄位。匯入只載入草稿，提示詞獨立儲存；舊檔缺少此欄位時保持目前內容。

## 儲存與初始化

正式值位於 SQLite `Config` 表的 `ai_lyrics_prompt` key，JSON 內容為 `text` 與 `revision`，時間沿用 `updated_at`。

`backend/app/prompts/lyrics_cleanup.txt` 逐字保留原 Python 字串，包括換行和尾端空白。啟動時使用 `INSERT OR IGNORE` 初始化；重啟和重新部署不覆蓋既有自訂內容。文字檔僅作首次初始化與載入預設的來源。後續日常修改請透過 Web UI。

提示詞由 `prompt_service.py` 直接讀取 SQLite，不使用通用設定的進程快取。儲存時在同一 transaction 取得寫入鎖、比對版本並更新。通用設定 API 禁止直接修改或刪除此 key。

## API

- `GET /api/prompts/lyrics`：回傳 `text`、`default_text`、`revision`、`updated_at`。
- `PUT /api/prompts/lyrics`：送入 `text`、`expected_revision`；版本不符回傳 409，輸入不合法回傳 422。
- `POST /api/prompts/lyrics/preview`：送入 `text`、`lyric`，回傳 `{result}`；AI 呼叫失敗回傳 502。
- 原有 `POST /api/tools/lyric` 保持 `{lyric}` → `{result}`。

模型、訊息角色和模型參數沿用原有設定；API key 保留在後端。輸出若達到 token 上限，回報錯誤並保留編輯器原歌詞。

## 驗證與部署

在 `backend/` 執行：

```sh
uv run python -m unittest discover -s tests -p test_prompts.py -v
```

測試使用臨時 SQLite 與模擬 AI，包含原提示詞雜湊、初始化不覆蓋、持久化、並行版本衝突、通用 API 保護、草稿試跑不寫入、正常入口即時讀取及失敗處理。

在 `frontend/` 執行 `npm run build`。瀏覽器回歸測試也可在該目錄執行（使用模擬 API，不產生 AI 費用）：

```sh
uv run --no-project --with playwright python -m playwright install chromium
uv run --no-project --with playwright python tests/prompt-manager.e2e.py
```

部署前使用 SQLite backup API 備份實際資料庫，再建置前後端容器；部署後檢查健康端點、提示詞讀取與頁面載入，並確認重啟不改變提示詞版本或內容。回退程式時保留 DB，舊版程式會忽略這個新增設定 key。
