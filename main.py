import base64
import logging
import os
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import List

import uvicorn
from fastapi import Body, FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from movie_maker import BrowserConfig, MovieConfig, MovieMaker
from movie_maker.config import ImageConfig
from pydantic import BaseModel

from gcs import BucketManager
from util import image2mp4

logger = logging.getLogger('uvicorn')
BUCKET_NAME = os.environ.get("BUCKET_NAME", None)

ROOT_DIR = Path(os.path.dirname(__file__))
STATIC_DIR = ROOT_DIR / "static"

templates = Jinja2Templates(directory=ROOT_DIR / "templates")

app = FastAPI()
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


@app.get("/image/")
async def read_index(request: Request) -> templates.TemplateResponse:
    return templates.TemplateResponse('image.html', {'request': request})


@app.get("/desktop/")
async def read_index(request: Request) -> templates.TemplateResponse:
    return templates.TemplateResponse('desktop_share.html', {'request': request})


@app.get("/github")
async def read_index(request: Request) -> templates.TemplateResponse:
    return templates.TemplateResponse('github.html', {'request': request})


@app.get("/favicon.ico")
async def favicon() -> FileResponse:
    return FileResponse((STATIC_DIR / 'favicon.ico'))


class BrowserSetting(BaseModel):
    url: str
    lang: str
    page_height: int
    width: int
    height: int
    catch: bool


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
                                   browser_setting.page_height, scroll, lang=browser_setting.lang)
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
    delete_at = datetime.now().timestamp() + 60 * 60 * 24 * 7
    return {'url': url, 'delete_at': delete_at}


@app.post("/api/create_image_movie/")
async def create_image_movie(files: List[UploadFile], width: int = 1280) -> dict:
    """
    Merge images and create a movie.
    :param files: List of image files
    :param width: Browser width
    :param page_height: Max scroll height
    :param scroll: Scroll height
    :return: Download URL
    """
    bucket_manager = BucketManager(BUCKET_NAME)
    name = str(uuid.uuid4())
    image_dir = Path('image') / name
    image_dir.mkdir(exist_ok=True, parents=True)
    image_config = ImageConfig(image_dir)
    movie_path = Path(f"movie/{name}.mp4")
    logger.info(f"image_dir: {image_dir.absolute()}")
    for f in files:
        image_path = str(image_dir.joinpath(f.filename).absolute())
        logger.info(f"image_path: {image_path}")
        with open(image_path, "wb") as buffer:
            shutil.copyfileobj(f.file, buffer)
    output_image_dir = MovieMaker.format_images(image_config)
    movie_config = MovieConfig(output_image_dir, movie_path, width=width)
    MovieMaker.image_to_movie(movie_config)
    url = bucket_manager.to_public_url(str(movie_path))
    delete_at = datetime.now().timestamp() + 60 * 60 * 24 * 7
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


@app.get("/api/create_github_movie/")
def create_github_movie(url: str, targets: str, width: int = 1280, height: int = 720, page_height: int = 50000,
                        scroll: int = 200, catch: bool = True) -> dict:
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
    targets = targets.split(",")
    if len(url) == 0:
        raise HTTPException(
            status_code=400, detail="URL is empty.Please set URL.")
    if url.startswith("https://github.com/") is False or len(url.split('/')) >= 5:
        raise HTTPException(
            status_code=400, detail="URL is not GitHub repository.")
    bucket_manager = BucketManager(BUCKET_NAME)
    browser_config = BrowserConfig(
        url, width, height, page_height, scroll, targets=targets)
    logger.info(f"browser_config: {browser_config}")
    movie_path = Path(f"movie/{browser_config.hash}.mp4")
    if catch and movie_path.exists():
        url = bucket_manager.get_public_file_url(str(movie_path))
        return {'url': url, 'delete_at': None}
    # Download the repository.
    image_dir = MovieMaker.take_screenshots_github_files(browser_config)
    movie_config = MovieConfig(image_dir, movie_path, width=width)
    MovieMaker.image_to_movie(movie_config)
    # Upload to GCS
    url = BucketManager(BUCKET_NAME).to_public_url(str(movie_path))
    delete_at = datetime.now().timestamp() + 60 * 60 * 24 * 7
    return {'url': url, 'delete_at': delete_at}


if __name__ == '__main__':
    uvicorn.run(app, host="0.0.0.0", port=8000)
