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

Import progress is stored in Redis, so leaving the page or restarting the backend does not lose it. Unfinished imports are listed at the top of the import page and on the Cache page. Use **繼續** to pick up from the step where the import stopped, with no re-upload. A file whose progress was lost (from before this change, or without Redis) can still be processed again from its staged copy. You pick a target folder, and tags already written to the file are kept.

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
- **Move files with their tags** — when an edit changes the first artist, album, title or track number, saving offers to move the file to the matching path (only the changed path segment is replaced, one song at a time)

### Integrations
Optional connections to outside services, switched on and configured under **Settings → 整合**. With an integration off, the core features keep working without it.
- **Navidrome**
  - Asks a host-side refresh hook to rescan after cover changes, imports, M3U generation and file moves ([deploy/navidrome-refresh-hook](deploy/navidrome-refresh-hook)).
  - When you edit tags and move the file, the move waits until Navidrome has scanned the new tags, so play counts, loves and ratings are kept.
  - Can sync favorites both ways: the NexTags `FAVORITE` tag and Navidrome's starred songs. The first sync shows a preview and lets you choose how to merge. After that, each change goes to the other side automatically.
- **AI lyrics**: the Claude lyrics cleanup. Without an API key, the button is hidden.

Passwords and API keys are stored encrypted with `NEXTAGS_SECRET_KEY`. They can be written but are never returned by the API or included in config exports.

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
NEXTAGS_SECRET_KEY=                    # Encrypts integration secrets (see .env.example)

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
In the tag editor, use the lyrics tool to clean up LRC lyrics. Enable **AI 歌詞整理** under Settings → 整合 and enter the Anthropic API key there (it is stored encrypted; environment variables are not used).

AI lyrics instructions can be edited in **Settings → 整合 → AI 歌詞整理** (`/settings?tab=integrations&integration=ai_lyrics`; the old `?tab=prompts` link redirects there), with draft previews, explicit saving, and default restoration. See [prompt management](docs/prompt-management.md) for storage, API, and maintenance details.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MUSIC_ROOT_PATH` | Yes | — | Host path to the music library, mounted at `/Music` |
| `REDIS_HOST` | Yes | `localhost` | Use `redis` with the bundled compose files |
| `REDIS_PORT` | Yes | `6379` | |
| `REDIS_DB` | No | `0` | |
| `NEXTAGS_SECRET_KEY` | Recommended | — | Fernet key that encrypts secrets saved under Settings → 整合. Without it, integration secrets cannot be saved |
| `NAVIDROME_HOOK_STATUS_FILE` | No | `/app/data/navidrome_status/status.json` | Scan status written by the refresh hook |
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
