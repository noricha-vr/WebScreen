# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

| Item | Value |
|------|-------|
| Local URL | http://localhost:8080 |
| Container Name | web_screen |
| Python Version | 3.10 |
| Framework | FastAPI |
| Storage | Google Cloud Storage |
| GCP Project ID | noricha |

## Project Overview

WebScreen converts web pages, images, PDFs, and desktop recordings into MP4 videos optimized for VRChat video players. Users upload content via a web interface, and the system generates streamable videos hosted on GCS.

## Development Commands

```bash
# Start local development
docker compose up -d

# Access container shell
docker exec -it web_screen bash

# Stop containers
docker compose down

# Update translations
pybabel extract -F babel.cfg -o messages.pot . templates
pybabel update -i messages.pot -d lang
pybabel compile -d lang
```

## Architecture

### Request Flow

```
Browser → FastAPI (router/main.py) → API endpoints (router/api.py)
                                   → Page routes (router/main_page.py)
```

### Core Components

| Directory | Purpose |
|-----------|---------|
| `router/` | FastAPI app, API endpoints, page routes |
| `movie_maker/` | Screenshot capture (Selenium), ffmpeg video encoding |
| `templates/` | Jinja2 HTML templates (i18n via babel) |
| `static/js/` | Frontend JS per feature (pdf.js, web.js, etc.) |
| `gcs.py` | Google Cloud Storage upload/public URL handling |

### Video Generation Pipeline

1. **Web/GitHub**: Selenium headless Chrome captures screenshots → ffmpeg encodes to MP4
2. **Images**: Resize/center images → ffmpeg encodes to MP4
3. **PDF (WASM)**: Client-side PDF.js renders to canvas → FFmpeg.wasm encodes to MP4 → uploads to server
4. **Recording**: MediaRecorder captures desktop → server converts to VRChat-compatible format

### Key Technical Details

- **COOP/COEP Headers**: Applied to `/ja/pdf/`, `/en/pdf/`, `/static/js/`, `/api/save-movie/` for SharedArrayBuffer (required by FFmpeg.wasm)
- **ffmpeg Settings**: h264, yuv420p, baseline profile, bf=0, g=1 (all keyframes for VRChat compatibility)
- **i18n**: Routes prefixed with `/{lang}/` (en/ja), babel for translations

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BUCKET_NAME` | GCS bucket name (default: vrchat) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to GCS credentials JSON |
| `ALLOW_HOST` | CORS allowed origin |
| `DEBUG` | Enable debug mode ("True") |

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/url-to-movie/` | Convert webpage to video |
| `POST /api/image-to-movie/` | Convert images to video |
| `POST /api/pdf-to-movie/` | Convert PDF to video (server-side) |
| `POST /api/save-movie/` | Save client-generated video to GCS |
| `POST /api/create_github_movie/` | Convert GitHub repo files to video |
| `POST /api/stream/` | HLS streaming upload |
