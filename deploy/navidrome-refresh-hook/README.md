# Navidrome refresh hook

NexTags 在匯入、封面更新、產生 M3U、以及排程檔案移動時，會把請求寫到
`/app/data/navidrome_refresh/request.json`（docker volume `nextags_app-data`）。
主機上的 systemd 監看這個資料夾，觸發這個腳本重建 Navidrome 容器並執行快速掃描。

掃描結束後腳本會寫入 `/app/data/navidrome_status/status.json`：

```json
{"ok": true, "request_requested_at": "<這次掃描涵蓋的請求時間>", "completed_at": "<完成時間>"}
```

NexTags 的「編輯後移動檔案」依此判斷：涵蓋標籤寫入的掃描已完成，才實際搬移檔案，
讓 Navidrome 先記下新標籤，搬移時才認得出同一首歌、保留播放紀錄。
狀態檔必須放在 `navidrome_refresh/` 以外，否則寫入會再次觸發 `.path` unit，造成無限掃描。

## 安裝位置

| 檔案 | 主機路徑 |
|---|---|
| `nextags-navidrome-refresh-hook.sh` | `/usr/local/sbin/`（可執行） |
| `nextags-navidrome-refresh-hook.path` | `/etc/systemd/system/` |
| `nextags-navidrome-refresh-hook.service` | `/etc/systemd/system/` |

```bash
install -m 755 nextags-navidrome-refresh-hook.sh /usr/local/sbin/
install -m 644 nextags-navidrome-refresh-hook.path nextags-navidrome-refresh-hook.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nextags-navidrome-refresh-hook.path
```

紀錄寫在 `/var/log/nextags-navidrome-refresh-hook.log`。
