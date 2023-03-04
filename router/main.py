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
from i18n import babel
from fastapi_babel.middleware import InternationalizationMiddleware as I18nMiddleware

logger = get_logger(__name__)
DEBUG = os.getenv('DEBUG') == 'True'
BUCKET_NAME = os.environ.get("BUCKET_NAME", None)
ROOT_DIR = Path(os.path.dirname(__file__)).parent
STATIC_DIR = ROOT_DIR / "static"
MOVIE_DIR = ROOT_DIR / "movie"

app = FastAPI(debug=DEBUG)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/movie", StaticFiles(directory=MOVIE_DIR), name="movie")
app.add_middleware(I18nMiddleware, babel=babel)

origins = [
    os.environ.get("ALLOW_HOST", None)
]

logger.info(f"origins: {origins}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origins],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api.router, prefix="/api")
app.include_router(main_page.router, )


# Redirects
@app.get("/", response_class=HTMLResponse)
async def home(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/", status_code=301)


@app.get("/web/", response_class=HTMLResponse)
async def web(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/web/", status_code=301)


@app.get("/image/")
async def image(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/image/", status_code=301)


@app.get("/pdf/")
async def pdf(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/pdf/", status_code=301)


@app.get("/recording/")
def recording_desktop(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/recording/", status_code=301)


@app.get("/record-screen/")
def recording_desktop(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/recording/", status_code=301)


@app.get("/streaming/")
async def read_index(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/streaming/", status_code=301)


@app.get("/history/", response_class=HTMLResponse)
async def history(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/history/", status_code=301)


@app.get("/github/")
async def github(request: Request) -> RedirectResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/github/", status_code=301)


@app.get("/robots.txt/")
async def robots_txt():
    return FileResponse("../static/robots.txt")


@app.get("/sitemap.xml")
async def sitemap():
    return FileResponse("../static/sitemap.xml")


@app.get("/favicon.ico")
async def favicon() -> FileResponse:
    return FileResponse((STATIC_DIR / 'favicon.ico'))


# Streaming file from GCS
@app.get("/stream/{uuid}/{file_name}")
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


@app.get("/cache/{file_path:path}")
async def read_static_file(file_path: str):
    try:
        file_path = STATIC_DIR / file_path
        if file_path.exists() is False:
            raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(file_path, headers={"Cache-Control": "public, max-age=3600"})
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")


if __name__ == '__main__':
    # reload = True
    uvicorn.run(app, host="0.0.0.0", port=8000)
