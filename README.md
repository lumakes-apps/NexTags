# NexTags

Self-hosted music library management system with smart playlists, a guided import workflow, and AI-assisted lyrics cleanup.

Built with FastAPI and React, deployed via Docker Compose.

## Features

### Music Library Management
- Browse your library with server-side pagination and filter by title, folder, language, and favorites
- Tag editor for 20+ metadata fields (ID3v2 / Vorbis comments / MP4 atoms), including track number, lyrics, and cover art
- Cover art display and upload, ReplayGain loudness tags
- Library scanning covers MP3, FLAC, M4A, OGG, WAV, AAC, and WMA; tag writing supports MP3, FLAC, OGG, and M4A

### Smart Playlists
- Include/exclude tag filters, include/exclude language filters, and a favorites toggle
- Sort by title or date added (the time a file first entered the library; editing tags does not change it)
- Export playlists as M3U files (single or batch, batch runs in the background)
- Import/export all playlist configurations as JSON — see [PLAYLIST_CONFIG.md](PLAYLIST_CONFIG.md)

### Music Import Workflow
A guided multi-step process to add new music to the library:

1. Upload audio files to a staging area (large files are sent in chunks)
2. Convert M4A to FLAC (tags and cover preserved)
3. Extract and review metadata
4. Edit tags and the target filename
5. Detect missing artist folders and upload artist images
6. Move files to the correct library path (artist, album, and file names are cleaned to be FAT-safe; tags keep the original text)
7. Generate ReplayGain tags

### AI Lyrics Processing
Uses the Anthropic Claude API to clean up LRC lyrics. The default instructions below can be edited on the Settings page:
- Normalize LRC timestamps to `[mm:ss.xx]`
- Convert Simplified Chinese to Traditional Chinese
- Append inline Chinese translations to non-Chinese lines (English, Korean, etc.)

### Other
- **ReplayGain** — single-file or batch, computed with FFmpeg's `replaygain` filter
- **Redis cache** — tag cache and audio catalog with statistics and rebuild tools on the Cache page
- **Background jobs** — cache rebuild, batch ReplayGain, and batch M3U generation run in the background with their status kept in Redis; jobs interrupted by a restart are marked as failed and must be started again
- **Drag-and-drop settings** — reorder music folders, tags, and languages
- **Navidrome hook** — after a cover change, an import is moved into the library, or M3U files are generated, the backend writes a refresh request file that a host-side watcher can use to trigger a Navidrome rescan (tag-only edits do not write it)

## Quick Start

### Prerequisites
- Docker & Docker Compose
- A music directory on the host machine
- (Optional) Anthropic API key for lyrics processing

### 1. Clone and configure

```bash
git clone https://github.com/tony13382/NexTags.git
cd NexTags
cp .env.example .env
```

Edit `.env`:

```env
MUSIC_ROOT_PATH=/path/to/your/music   # Mounted into the backend as /Music
ANTHROPIC_TOKEN=                       # Optional, for AI lyrics processing

REDIS_HOST=redis                       # Service name in docker-compose
REDIS_PORT=6379
REDIS_DB=0
```

See [Environment Variables](#environment-variables) for all options.

### 2. Start the application

```bash
make prod   # Production (Nginx serves the built frontend)
make dev    # Development (Vite HMR + uvicorn --reload)
```

Both bind the frontend to **http://localhost:4000** and the backend API to **http://localhost:6000**.

### 3. Initial setup

1. Open http://localhost:4000/settings
2. Add your music folders (e.g. Chinese, Japanese, English)
3. Configure supported tags and languages
4. Go to the Cache page and rebuild the cache

## Usage

### Browsing and editing
Open the home page to browse the library. Use the filters at the top to search by title, folder, language, or favorites. Click a track to open the tag editor.

### Smart playlists
On the Playlists page, create a playlist, set filter criteria and sort order, and save. Generate M3U files for any player that reads them.

### Importing new music
On the New page, upload an audio file and follow the steps: review extracted tags, edit if needed, upload an artist image for new artists, confirm the final location, and generate ReplayGain.

### Processing lyrics
In the tag editor, use the lyrics tool to clean up LRC lyrics. Requires `ANTHROPIC_TOKEN` in `.env`.

AI lyrics instructions can be edited in **Settings → 提示詞管理** (`/settings?tab=prompts`), with draft previews, explicit saving, and default restoration. See [prompt management](docs/prompt-management.md) for storage, API, and maintenance details.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MUSIC_ROOT_PATH` | Yes | — | Host path to the music library, mounted at `/Music` |
| `REDIS_HOST` | Yes | `localhost` | Use `redis` with the bundled compose files |
| `REDIS_PORT` | Yes | `6379` | |
| `REDIS_DB` | No | `0` | |
| `ANTHROPIC_TOKEN` | No | — | Enables AI lyrics processing |
| `SQLITE_DB_PATH` | No | `/app/data/musicmanager.db` | SQLite file for playlists and config |
| `CORS_ALLOW_ORIGINS` | No | `*` | Comma-separated origins; credentials are only allowed when not `*` |
| `NAVIDROME_HOOK_REQUEST_FILE` | No | `/app/data/navidrome_refresh/request.json` | Where the Navidrome refresh request is written |
| `USER_ID` / `GROUP_ID` | No | `1000` | Build args for the production backend user; match your host user to avoid permission issues (see [PERMISSION_FIX.md](PERMISSION_FIX.md)) |

## Makefile Commands

```bash
make dev           # Start development environment
make dev-d         # Start development environment in background
make prod          # Start production environment
make prod-d        # Start production environment in background
make stop          # Stop all services
make logs          # Follow dev logs (logs-prod, logs-backend, logs-frontend)
make rebuild       # Rebuild and start dev environment (rebuild-prod for production)
make restart       # Restart dev environment
make shell-backend # Shell into the dev backend container
make ps            # View container status
make clean         # Stop and delete all volumes (destructive)
make help          # Show available commands
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI, uvicorn, Python 3.11, uv |
| Storage | SQLite (playlists, config), Redis (tag cache, audio catalog, task state) |
| Frontend | React 19, Vite, Tailwind CSS 4, shadcn/ui, React Router 7 |
| Audio | Mutagen, FFmpeg |
| AI | Anthropic Claude API |
| Infrastructure | Docker Compose, Nginx |

## Architecture

```
Browser ──► frontend (:4000)
              ├─ prod: Nginx serves the built SPA and proxies /api ──► backend
              └─ dev:  Vite dev server proxies /api ─────────────────► backend
            backend (:6000 → 8000, FastAPI, all routes under /api)
              ├─ SQLite  /app/data/musicmanager.db   (app-data volume)
              ├─ Redis   tag cache, catalog, tasks   (redis-data volume)
              └─ /Music  host music library (read/write)
```

## Project Structure

```
.
├── backend/
│   ├── main.py             # FastAPI app, CORS, router registration, task worker startup
│   ├── config.py           # Loads .env
│   ├── app/
│   │   ├── router/         # API endpoints (audio, playlists, music_import, cache, config, tasks, tags, tools, images)
│   │   ├── dependencies/   # Tag read/write, Redis cache, SQLite, lyrics processing, audio utils
│   │   ├── schemas/        # Pydantic models
│   │   ├── prompts/        # Default AI prompt templates
│   │   └── services/       # Background task manager, Redis-backed shared state
│   ├── scripts/            # One-off maintenance scripts (e.g. PostgreSQL → SQLite migration)
│   └── tests/              # unittest suite
├── frontend/
│   ├── src/
│   │   ├── pages/          # Home, New, Playlists, Playlist, Cache, Settings
│   │   ├── components/     # Tag editors, dialogs, shadcn/ui components
│   │   ├── hooks/
│   │   └── lib/            # API client, utilities
│   ├── nginx.conf          # Nginx config used by the production frontend image
│   └── tests/              # Playwright specs (API is mocked)
├── docs/                   # Engineering notes and audit reports
├── docker-compose.yml      # Production
├── docker-compose.dev.yml  # Development
└── Makefile
```

## Testing

```bash
# Backend (from backend/; FLAC integration tests are skipped if ffmpeg is missing)
uv run python -m unittest discover tests

# Frontend (from frontend/; starts its own Vite server and mocks the API)
npm run test:import
npm run test:cover
```

## Development

See the [Development Guide](README.dev.md) for hot reload, logs, and debugging, and [Production Deployment](README.prod.md) for production notes.

## API Documentation

With the backend running:
- Swagger UI: http://localhost:6000/docs
- ReDoc: http://localhost:6000/redoc

## License

MIT License. See [LICENSE](LICENSE) for details.

## Contributing

Issues and pull requests are welcome!
