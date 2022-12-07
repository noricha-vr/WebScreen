import base64
import logging
import os
import shutil
import subprocess
import time
from uuid import uuid4
from datetime import datetime
from pathlib import Path
from typing import List

import PIL.Image
import cv2
import uvicorn
from PIL.Image import Image
from fastapi import Body, FastAPI, HTTPException, Request, UploadFile, Form, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from movie_maker import BrowserConfig, MovieConfig, MovieMaker
from movie_maker.config import ImageConfig
from starlette.responses import StreamingResponse

from gcs import BucketManager
from models import BrowserSetting, GithubSetting
from util import image2mp4, pdf_to_image

logger = logging.getLogger('uvicorn')
DEBUG = os.getenv('DEBUG') == 'True'
BUCKET_NAME = os.environ.get("BUCKET_NAME", None)

ROOT_DIR = Path(os.path.dirname(__file__))
STATIC_DIR = ROOT_DIR / "static"

templates = Jinja2Templates(directory=ROOT_DIR / "templates")
app = FastAPI(debug=DEBUG)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

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


@app.get("/", response_class=HTMLResponse)
async def read_index(request: Request) -> templates.TemplateResponse:
    return templates.TemplateResponse('index.html', {'request': request})


@app.get("/pdf/")
async def read_index(request: Request) -> templates.TemplateResponse:
    return templates.TemplateResponse('pdf.html', {'request': request})


@app.get("/image/")
async def read_index(request: Request) -> templates.TemplateResponse:
    return templates.TemplateResponse('image.html', {'request': request})


@app.get("/desktop/")
async def read_index(request: Request) -> templates.TemplateResponse:
    return templates.TemplateResponse('desktop_share.html', {'request': request})


@app.get("/github/")
async def read_index(request: Request) -> templates.TemplateResponse:
    return templates.TemplateResponse('github.html', {'request': request})


@app.get("/favicon.ico")
async def favicon() -> FileResponse:
    return FileResponse((STATIC_DIR / 'favicon.ico'))


@app.post("/api/create_movie/")
def create_movie(browser_setting: BrowserSetting) -> dict:
    """
    Take a screenshot of the given URL. The screenshot is saved in the GCS. Return the file of download URL.
    1. create hash of URL, scroll_px, width, height. max_height.
    2. check if the movie file exists.
    3. if the movie file exists, return the download url.
    4. if the movie file does not exist, take a screenshot and save it to the GCS.
    :param browser_setting:
    :return: Download URL
    """
    if len(browser_setting.url) == 0:
        raise HTTPException(
            status_code=400, detail="URL is empty.Please set URL.")
    if browser_setting.url.startswith("http") is False:
        raise HTTPException(
            status_code=400, detail="URL is not valid. Please set URL.")
    bucket_manager = BucketManager(BUCKET_NAME)
    scroll = int(browser_setting.height // 3)
    browser_config = BrowserConfig(browser_setting.url, browser_setting.width, browser_setting.height,
                                   browser_setting.page_height, scroll, lang=browser_setting.lang,
                                   wait_time=browser_setting.wait_time)
    logger.info(f"browser_config: {browser_config}")
    movie_path = Path(f"movie/{browser_config.hash}.mp4")
    if movie_path.exists() and browser_setting.catch:
        url = bucket_manager.get_public_file_url(str(movie_path))
        return {'url': url, 'delete_at': None}
    try:
        image_dir = MovieMaker.take_screenshots(browser_config)
    except Exception as e:
        logger.error(f'Failed to make movie.  url: {browser_setting.url} {e}')
        raise HTTPException(status_code=500, detail="Failed to create movie.")
    movie_config = MovieConfig(
        image_dir, movie_path, width=browser_setting.width)
    MovieMaker.image_to_movie(movie_config)
    # Upload to GCS
    url = BucketManager(BUCKET_NAME).to_public_url(str(movie_path))
    delete_at = datetime.now().timestamp() + 60 * 60 * 24 * 14
    return {'url': url, 'delete_at': delete_at}


@app.post("/api/image-to-movie/")
async def create_image_movie(images: List[UploadFile]) -> dict:
    """
    Merge images and create a movie.
    :param images: List of image files
    :return: Download URL
    """
    bucket_manager = BucketManager(BUCKET_NAME)
    name = str(uuid4())
    image_dir = Path('image') / name
    image_dir.mkdir(exist_ok=True, parents=True)
    output_image_dir = Path('image') / f'{name}_output'
    image_config = ImageConfig(image_dir, output_image_dir)
    movie_path = Path(f"movie/{name}.mp4")
    logger.info(f"image_dir: {image_dir.absolute()}")
    for image in images:
        image_path = str(image_dir.joinpath(image.filename).absolute())
        logger.info(f"image_path: {image_path}")
        with open(image_path, "wb") as buffer:
            shutil.copyfileobj(image.file, buffer)
    MovieMaker.format_images(image_config)
    movie_config = MovieConfig(output_image_dir, movie_path)
    MovieMaker.image_to_movie(movie_config)
    url = bucket_manager.to_public_url(str(movie_path))
    delete_at = datetime.now().timestamp() + 60 * 60 * 24 * 14
    return {'url': url, 'delete_at': delete_at}


def add_frames(image_dir: Path, frame_sec: int) -> None:
    """
    Add frames to the image directory. Image file format is png.
    :param image_dir: Image directory
    :param frame_sec: Frame rate
    :return: None
    """
    max_frame_sec = 2
    if frame_sec > max_frame_sec:
        frame_sec = max_frame_sec
    image_paths = sorted(image_dir.glob("*.png"))
    for image_path in image_paths:
        for i in range(frame_sec - 1):
            shutil.copy(image_path, image_path.parent / f"{image_path.stem}_{i}.png")


@app.post('/api/pdf-to-movie/')
async def pdf_to_movie(pdf: UploadFile = File(), frame_sec: int = Form(...)) -> dict:
    """
    Convert PDF to movie.
    :param pdf: PDF file
    :param frame_sec: Frame par second
    :return: Download URL
    """
    bucket_manager = BucketManager(BUCKET_NAME)
    name = str(uuid4())
    image_dir = Path('image') / name
    image_dir.mkdir(exist_ok=True, parents=True)
    movie_path = Path(f"movie/{name}.mp4")
    pdf_to_image(pdf.file.read(), image_dir)
    add_frames(image_dir, frame_sec)
    movie_config = MovieConfig(image_dir, movie_path, encode_speed='slow')
    MovieMaker.image_to_movie(movie_config)
    url = bucket_manager.to_public_url(str(movie_path))
    delete_at = datetime.now().timestamp() + 60 * 60 * 24 * 14
    return {'url': url, 'delete_at': delete_at}


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


@app.post('/api/receive-image/')
async def receive_image(request: Request, body: bytes = Body(...)):
    """
    Upload image file and convert to mp4. Movie file is saved in 'movie/{session_id}.mp4'. Header has `session_id`.
    body is posted by canvas.toDataURL().
    :param request:
    :param body: base64 image.
    :return: message
    """
    token = request.headers.get('session_id')
    if token is None:
        raise HTTPException(status_code=400, detail="session_id is empty.")
    movie_path = Path(f"movie/{token}.mp4")
    temp_movie_path = Path(f"movie/{token}_temp.mp4")
    image_data = str(body).split(',')[1]
    image_path = Path(f"image/{token}/desktop.png")
    image_path.parent.mkdir(exist_ok=True, parents=True)
    with open(image_path, "wb") as f:
        f.write(base64.b64decode(bytes(image_data, 'utf-8')))
    image2mp4(str(image_path.parent), str(temp_movie_path))
    temp_movie_path.rename(movie_path)
    return {"message": f"success. URL: /api/receive-image/{token}/"}


@app.get("/streaming/")
async def read_index(request: Request) -> templates.TemplateResponse:
    return templates.TemplateResponse('streaming.html', {'request': request})


@app.get("/record-screen/")
def record_desktop(request: Request) -> templates.TemplateResponse:
    """
    Recode user desktop or window. Then post the movie to /api/save-movie/
    """
    return templates.TemplateResponse('screen-recording.html', {'request': request})


@app.post("/api/save-movie/")
def recode_desktop(file: bytes = File()) -> dict:
    """
    Save movie file. Convert movie for VRChat format. Upload Movie file on GCS. Return download url.
    :param file: base64 movie.
    :return: message
    """
    if file:
        temp_movie_path = Path(f"movie/{uuid4()}_temp.mp4")
        movie_path = Path(f"movie/{uuid4()}.mp4")
        with open(temp_movie_path, "wb") as f:
            f.write(file)
        start = time.time()
        movie_config = MovieConfig(
            temp_movie_path, movie_path, width=1280, encode_speed='ultrafast')
        MovieMaker.to_vrc_movie(movie_config)
        logger.info(f"to_vrc_movie: {time.time() - start}")
        bucket_manager = BucketManager(BUCKET_NAME)
        url = bucket_manager.to_public_url(str(movie_path))
        logger.info(f"url: {url}")
        return {"url": url, "delete_at": datetime.now().timestamp() + 60 * 60 * 24 * 14}
    return {"message": "not found file."}


@app.post("/api/create_github_movie/")
def create_github_movie(github_setting: GithubSetting) -> dict:
    """
    Download github repository, convert file into HTML, and take a screenshot.
    :param url: URL to take a screenshot
    :param targets: target file list to take a screenshot
    :param width: Browser width
    :param height: Browser height
    :param page_height: Max scroll height
    :param scroll: scroll height
    :param catch: if catch is true, check saved movie is suitable.
    :return: GitHub repository page URL
    """
    targets = github_setting.targets.split(",")
    if len(github_setting.url) == 0:
        raise HTTPException(
            status_code=400, detail="URL is empty.Please set URL.")
    if github_setting.url.startswith("https://github.com/") is False:
        raise HTTPException(
            status_code=400, detail="URL is not GitHub repository.")
    bucket_manager = BucketManager(BUCKET_NAME)
    scroll = github_setting.height // 3
    wait_time = 0  # local file don't need to wait.
    browser_config = BrowserConfig(
        github_setting.url, github_setting.width, github_setting.height, github_setting.page_height, scroll,
        targets=targets, wait_time=wait_time)
    logger.info(f"browser_config: {browser_config}")
    movie_path = Path(f"movie/{browser_config.hash}.mp4")
    if github_setting.cache and movie_path.exists():
        url = bucket_manager.get_public_file_url(str(movie_path))
        return {'url': url, 'delete_at': None}
    # Download the repository.
    image_dir = MovieMaker.take_screenshots_github_files(browser_config)
    movie_config = MovieConfig(image_dir, movie_path, width=github_setting.width)
    MovieMaker.image_to_movie(movie_config)
    # Upload to GCS
    url = BucketManager(BUCKET_NAME).to_public_url(str(movie_path))
    delete_at = datetime.now().timestamp() + 60 * 60 * 24 * 14
    return {'url': url, 'delete_at': delete_at}


@app.get("/stream/{uuid}/")
async def get_stream(uuid: str):
    """
    Get m3u8 file.
    :param uuid:
    :return:
    """
    movie_path = Path(f"movie/{uuid}/video.mp4")
    for i in range(20):
        if movie_path.exists(): break
        time.sleep(1)
    if movie_path.exists() is False:
        raise HTTPException(status_code=404, detail="File not found")

    def gen_movie():
        error_count = 0
        max_error_count = 100
        sleep_range = 0.2
        chunk_size = 1024
        with open(movie_path, mode="rb") as file:
            # Read 1MB at a time
            while error_count < max_error_count:
                data = file.read(chunk_size)
                if not data:
                    # wait for file update.
                    time.sleep(sleep_range)
                    error_count += 1
                else:
                    error_count = 0
                    yield data
        yield data

    return StreamingResponse(gen_movie(), media_type="video/mp4")


@app.post("/api/stream/")
def stream(movie: UploadFile = Form(), uuid: str = Form()) -> dict:
    """
    Uploader movie convert to .m3u8 file. Movie file is saved in 'movie/{session_id}/video.m3u8'.
    :param movie: movie file
    :param uuid: session id
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


if __name__ == '__main__':
    # reload = True
    uvicorn.run(app, host="0.0.0.0", port=8000)
