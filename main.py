import os
import shutil
import time
from uuid import uuid4
from datetime import datetime
from pathlib import Path
from typing import List
import uvicorn
from fastapi import FastAPI, HTTPException, Request, UploadFile, Form, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from movie_maker import BrowserConfig, MovieConfig, MovieMaker
from movie_maker.config import ImageConfig
from threading import Thread
import api

from gcs import BucketManager
from models import BrowserSetting, GithubSetting
from util import pdf_to_image, to_m3u8, upload_hls_files, add_frames
from utils.setup_logger import get_logger
from utils.i18n import get_lang

from i18n import babel, check_trans
from fastapi_babel.middleware import InternationalizationMiddleware as I18nMiddleware

logger = get_logger(__name__)
DEBUG = os.getenv('DEBUG') == 'True'
BUCKET_NAME = os.environ.get("BUCKET_NAME", None)

ROOT_DIR = Path(os.path.dirname(__file__))
STATIC_DIR = ROOT_DIR / "static"
MOVIE_DIR = ROOT_DIR / "movie"

templates = Jinja2Templates(directory=ROOT_DIR / "templates")
babel.install_jinja(templates)

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


@app.get("/", response_class=HTMLResponse)
async def home(request: Request) -> templates.TemplateResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/", status_code=301)


@app.get("/web/", response_class=HTMLResponse)
async def web(request: Request) -> templates.TemplateResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/web/", status_code=301)


@app.get("/image/")
async def image(request: Request) -> templates.TemplateResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/image/", status_code=301)


@app.get("/pdf/")
async def pdf(request: Request) -> templates.TemplateResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/pdf/", status_code=301)


@app.get("/recording/")
def recording_desktop(request: Request) -> templates.TemplateResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/recording/", status_code=301)


@app.get("/record-screen/")
def recording_desktop(request: Request) -> templates.TemplateResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/recording/", status_code=301)


@app.get("/streaming/")
async def read_index(request: Request) -> templates.TemplateResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/streaming/", status_code=301)


@app.get("/history/", response_class=HTMLResponse)
async def history(request: Request) -> templates.TemplateResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/history/", status_code=301)


@app.get("/github/")
async def github(request: Request) -> templates.TemplateResponse:
    return RedirectResponse(url=f"/{get_lang(request)}/github/", status_code=301)


@app.get("/robots.txt/")
async def robots_txt():
    return FileResponse("static/robots.txt")


@app.get("/sitemap.xml")
async def sitemap():
    return FileResponse("static/sitemap.xml")


@app.get("/favicon.ico")
async def favicon() -> FileResponse:
    return FileResponse((STATIC_DIR / 'favicon.ico'))


@app.get("/desktop/{session_id}/")
def send_desktop_movie(session_id: str):
    """
    Get movie which file name is 'movie/{session_id}.mp4.
    :param session_id:
    :return: movie file
    """
    movie_path = Path(f"movie/{session_id}.mp4")
    if not movie_path.exists():
        not_found_movie = 'https://storage.googleapis.com/noricha-public/web-screen/movie/not_found.mp4'
        return RedirectResponse(url=not_found_movie)
    return FileResponse(movie_path)


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


@app.post("/api/stream/")
def post_stream(request: Request, movie: UploadFile = Form(), uuid: str = Form(), is_first: bool = Form()) -> dict:
    """
    Uploader movie convert to .m3u8 file. Movie file is saved in 'movie/{session_id}/video.m3u8'.
    :param request: Request
    :param movie: movie file
    :param uuid: session id
    :param is_first: if is_first is true, create movie directory.
    :return: message
    """

    if not movie:
        raise HTTPException(status_code=400, detail="Movie file is empty.")
    movie_dir = Path(f"movie/{uuid}")
    movie_dir.mkdir(exist_ok=True, parents=True)
    movie_path = movie_dir / f"video.mp4"
    # write movie file.
    mode = "ab" if movie_path.exists() else "wb"
    with open(movie_path, mode) as f:
        f.write(movie.file.read())
    if not is_first: return {"message": "success"}

    # upload to GCS
    output_path = movie_dir / "video.m3u8"
    Thread(target=upload_hls_files, args=(output_path, uuid, BucketManager(BUCKET_NAME))).start()
    origin = request.headers["origin"]
    base_url = f"{origin}/stream/{uuid}/"
    # convert to m3u8 file.
    Thread(target=to_m3u8, args=(movie_path, output_path, base_url)).start()
    url = f'/api/stream/{uuid}/'
    return {"message": "ok", 'url': url}


@app.get("/api/delete-movie/")
def delete_movie() -> dict:
    """
    Delete movie files in movie directory. If file age is over 1 hour, delete the file.
    :return: message and deleted file list.
    """
    movie_dir = Path("movie")
    deleted_files = []
    _1_hour_ago = time.time() - 60 * 60
    for file in movie_dir.glob("**/*.mp4"):
        if file.is_dir():
            # if directory is empty, delete the directory.
            if len(list(file.glob("*"))) == 0: file.rmdir()
            deleted_files.append(str(file))
            continue
        if file.stat().st_mtime < _1_hour_ago:
            file.unlink()
            deleted_files.append(str(file))
    return {"message": "ok", "deleted_files": deleted_files}


@app.get("/cache/{file_path:path}")
async def read_static_file(file_path: str):
    try:
        file_path = STATIC_DIR / file_path
        if file_path.exists() is False:
            raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(file_path, headers={"Cache-Control": "public, max-age=3600"})
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")


@app.get("/{lang}/", response_class=HTMLResponse)
async def redirect_home(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('home.html', {'request': request})


@app.get("/{lang}/web/", response_class=HTMLResponse)
async def redirect_web(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('web.html', {'request': request})


@app.get("/{lang}/pdf/")
async def redirect_pdf(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('pdf.html', {'request': request})


@app.get("/{lang}/image/")
async def redirect_image(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('image.html', {'request': request})


@app.get("/{lang}/recording/")
def redirect_recording(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('record.html', {'request': request})


@app.get("/{lang}/streaming/")
async def redirect_streaming(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('streaming.html', {'request': request})


@app.get("/{lang}/history/", response_class=HTMLResponse)
async def redirect_history(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('history.html', {'request': request})


@app.get("/{lang}/github/")
async def redirect_github(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('github.html', {'request': request})


@app.get("/{lang}/privacy")
async def privacy(request: Request, lang: str):
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse("privacy.html", {"request": request})


if __name__ == '__main__':
    # reload = True
    uvicorn.run(app, host="0.0.0.0", port=8000)
