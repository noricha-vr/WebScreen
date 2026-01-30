import os
from datetime import datetime
from pathlib import Path
import uvicorn
from router import api
from router import main_page
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from gcs import BucketManager
from utils.setup_logger import get_logger
from utils.i18n import get_lang

logger = get_logger(__name__)
DEBUG = os.getenv('DEBUG') == 'True'
BUCKET_NAME = os.environ.get("BUCKET_NAME", None)
ROOT_DIR = Path(os.path.dirname(__file__)).parent
STATIC_DIR = ROOT_DIR / "static"
MOVIE_DIR = ROOT_DIR / "movie"


class COOPCOEPMiddleware:
    """
    SharedArrayBuffer を有効化するための COOP/COEP ヘッダーを追加する純粋な ASGI ミドルウェア

    FFmpeg.wasm が SharedArrayBuffer を必要とするため、以下のヘッダーが必要:
    - Cross-Origin-Embedder-Policy: require-corp
    - Cross-Origin-Opener-Policy: same-origin

    ただし、これらのヘッダーは外部リソース（GCS, CDN等）の読み込みをブロックするため、
    PDFページと関連リソース（/static/js/, /api/save-movie/）のみに適用する。
    """

    # COOP/COEPヘッダーを適用するパスのパターン
    ENABLED_PATHS = (
        '/ja/pdf/',
        '/en/pdf/',
        '/static/js/',
        '/api/save-movie/',
    )

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        should_add_headers = any(path.startswith(p) for p in self.ENABLED_PATHS)

        if not should_add_headers:
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"cross-origin-embedder-policy", b"credentialless"))
                headers.append((b"cross-origin-opener-policy", b"same-origin"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)


# FastAPI アプリケーションを作成
_fastapi_app = FastAPI(debug=DEBUG)
_fastapi_app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
_fastapi_app.mount("/movie", StaticFiles(directory=MOVIE_DIR), name="movie")

origins = [
    os.environ.get("ALLOW_HOST", None)
]

logger.info(f"origins: {origins}")

_fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=[origins],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_fastapi_app.include_router(api.router, prefix="/api")


# Redirects
@_fastapi_app.get("/", response_class=HTMLResponse)
async def home(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/", status_code=301)


@_fastapi_app.get("/web/", response_class=HTMLResponse)
async def web(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/web/", status_code=301)


@_fastapi_app.get("/image/")
async def image(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/image/", status_code=301)


@_fastapi_app.get("/pdf/")
async def pdf(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/pdf/", status_code=301)


@_fastapi_app.get("/recording/")
def recording_desktop(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/recording/", status_code=301)


@_fastapi_app.get("/record-screen/")
def recording_desktop_alias(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/recording/", status_code=301)


@_fastapi_app.get("/streaming/")
async def read_index(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/streaming/", status_code=301)


@_fastapi_app.get("/history/", response_class=HTMLResponse)
async def history(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/history/", status_code=301)


@_fastapi_app.get("/github/")
async def github(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/github/", status_code=301)


@_fastapi_app.get("/robots.txt/")
async def robots_txt():
    return FileResponse("static/robots.txt")


@_fastapi_app.get("/sitemap.xml")
async def sitemap():
    return FileResponse("static/sitemap.xml")


@_fastapi_app.get("/favicon.ico")
async def favicon() -> FileResponse:
    return FileResponse((STATIC_DIR / 'favicon.ico'))


# Streaming file from GCS
@_fastapi_app.get("/stream/{uuid}/{file_name}")
async def get_stream(uuid: str, file_name: str):
    """
    Get m3u8 file.
    :param uuid:
    :param file_name:
    :return:
    """
    mp4_file = Path(f"movie/{uuid}/{file_name}")
    bucket_manager = BucketManager(BUCKET_NAME)
    # if mp4_file modified time is over 3 min, return 404.
    if (datetime.now() - datetime.fromtimestamp(mp4_file.stat().st_mtime)).seconds > 60:
        bucket_manager.make_private(str(mp4_file))
        raise HTTPException(status_code=404, detail="File not found")
    movie_path = Path(f"movie/{uuid}/{file_name}")
    if bucket_manager.exists(str(movie_path)):
        url = bucket_manager.get_public_file_url(str(movie_path))
        return RedirectResponse(url)
    else:
        logger.info(f'Return local ts file. {movie_path}')
        return FileResponse(movie_path)


@_fastapi_app.get("/cache/{file_path:path}")
async def read_static_file(file_path: str):
    try:
        file_path = STATIC_DIR / file_path
        if file_path.exists() is False:
            raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(file_path, headers={"Cache-Control": "public, max-age=3600"})
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")


# main page needs to load after all routes. It routes all paths to `/{lang}/`
_fastapi_app.include_router(main_page.router)

# COOP/COEPミドルウェアでラップしたASGIアプリケーションをエクスポート
app = COOPCOEPMiddleware(_fastapi_app)

if __name__ == '__main__':
    # reload = True
    uvicorn.run(app, host="0.0.0.0", port=8000)
