# 生產環境部署說明

## 相關檔案

```
├── docker-compose.yml        # 生產環境 Docker Compose 配置
├── .env                      # 環境變數（由 .env.example 複製）
├── backend/
│   ├── Dockerfile.prod       # 後端映像：Python 3.11 + FFmpeg + uv，以非 root 使用者執行
│   └── entrypoint.sh         # 啟動前檢查 /Music 寫入權限
└── frontend/
    ├── Dockerfile.nginx      # 前端映像：先 vite build，再由 Nginx 提供靜態檔
    └── nginx.conf            # SPA 路由、靜態資源快取、/api 反向代理
```

## 服務架構

- **frontend**（主機 `127.0.0.1:4000` → 容器 80）：Nginx
  - `/` → 打包後的 React SPA
  - `/api` → 轉發到 `backend:8000`（上傳上限 200 MB）
- **backend**（主機 `127.0.0.1:6000` → 容器 8000）：FastAPI（uvicorn，單一 worker）
- **redis**：標籤快取、audio catalog、背景任務狀態（AOF 持久化）

兩個對外埠都只綁定在 `127.0.0.1`，要從外部存取請在前面再接反向代理或 tunnel。
`frontend/nginx.conf` 會固定送出 `X-Forwarded-Proto: https`（配合 Cloudflare Tunnel）。

## 資料保存

| 資料 | 位置 |
|---|---|
| 音樂檔案 | `${MUSIC_ROOT_PATH}` → 容器 `/Music`（讀寫） |
| SQLite（播放清單、設定） | `app-data` volume → `/app/data/musicmanager.db` |
| Redis 資料 | `redis-data` volume |

`docker-compose down -v` 會刪除 volume，播放清單與設定會一起消失。

## 部署命令

```bash
cp .env.example .env      # 設定 MUSIC_ROOT_PATH、REDIS_HOST=redis、REDIS_PORT=6379
make prod-d               # 等同 docker-compose up -d
make rebuild-prod         # 重建映像後啟動
make logs-prod            # 查看日誌
make stop                 # 停止服務
```

## 訪問方式

- 前端：http://localhost:4000
- 後端 API：http://localhost:4000/api/（經 Nginx）或 http://localhost:6000/api/
- 健康檢查：http://localhost:6000/health

## 注意事項

1. 後端映像以 `USER_ID` / `GROUP_ID`（預設 1000）建立使用者，請對齊主機上音樂資料夾的擁有者，否則會無法寫入標籤，詳見 [PERMISSION_FIX.md](PERMISSION_FIX.md)
2. 首次啟動後到 Settings 頁設定音樂資料夾，再到 Cache 頁重建快取
3. 所有服務設定為 `restart: unless-stopped`
