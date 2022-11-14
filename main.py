import base64
import logging
import os
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import List

from fastapi import FastAPI, HTTPException, UploadFile, Request, Body
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from movie_maker.config import ImageConfig
from gcs import BucketManager
from movie_maker import MovieMaker, BrowserConfig, MovieConfig

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


@app.get("/api/create_movie/")
def create_movie(url: str, lang: str, max_page_height: int, width: int = 1280, height: int = 720) -> dict:
    """
    Take a screenshot of the given URL. The screenshot is saved in the GCS. Return the file of download URL.
    1. create hash of URL, scroll_px, width, height. max_height.
    2. check if the movie file exists.
    3. if the movie file exists, return the download url.
    4. if the movie file does not exist, take a screenshot and save it to the GCS.
    :param url: URL to take a screenshot
    :param lang: language
    :param width: Browser width
    :param height: Browser height
    :param max_page_height: Max scroll height
    :return: Download URL
    """
    if len(url) == 0:
        raise HTTPException(status_code=400, detail="URL is empty.Please set URL.")
    bucket_manager = BucketManager(BUCKET_NAME)
    scroll = int(height // 3)
    browser_config = BrowserConfig(url, width, height, max_page_height, scroll, lang=lang)
    movie_path = Path(f"movie/{browser_config.hash}.mp4")
    if movie_path.exists():
        url = bucket_manager.get_public_file_url(str(movie_path))
        return {'url': url}
    try:
        image_dir = MovieMaker.take_screenshots(browser_config)
    except Exception as e:
        logger.error(f'Failed to make movie.  url: {url} {e}')
        raise HTTPException(status_code=500, detail="Failed to make movie.")
    movie_config = MovieConfig(image_dir, movie_path, width=width)
    MovieMaker.image_to_movie(movie_config)
    # Upload to GCS
    url = BucketManager(BUCKET_NAME).to_public_url(str(movie_path))
    return {'url': url}


@app.post("/api/create_image_movie/")
async def create_image_movie(files: List[UploadFile], width: int = 1280) -> dict:
    """
    Merge images and create a movie.
    :param files: List of image files
    :param width: Browser width
    :param max_page_height: Max scroll height
    :param scroll_each:
    :return: Download URL
    """
    bucket_manager = BucketManager(BUCKET_NAME)
    # TODO image_dir to uuid
    image_dir = Path('image') / datetime.utcnow().strftime('%Y%m%d-%H%M%S-%f')
    image_dir.mkdir(exist_ok=True, parents=True)
    image_config = ImageConfig(image_dir)
    movie_path = Path(f"movie/{image_config.hash}.mp4")

    print(f"image_dir: {image_dir.absolute()}")
    for f in files:
        image_path = str(image_dir.joinpath(f.filename).absolute())
        print(f"image_path: {image_path}")
        with open(image_path, "wb") as buffer:
            shutil.copyfileobj(f.file, buffer)
    output_image_dir = MovieMaker.format_images(image_config)
    movie_config = MovieConfig(output_image_dir, movie_path, width=width)
    MovieMaker.image_to_movie(movie_config)
    url = bucket_manager.to_public_url(str(movie_path))
    return {'url': url}


@app.get("/desktop/{session_id}/")
def send_desktop_movie(session_id: str):
    """
    Get movie which file name is 'movie/{session_id}.mp4.
    :param session_id:
    :return: movie file
    """
    movie_path = Path(f"movie/{session_id}.mp4")
    if not movie_path.exists():
        return FileResponse('movie/not_found.mp4')
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
    with open(image_path, "wb") as f: f.write(base64.b64decode(bytes(image_data, 'utf-8')))
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
    :param scroll:
    :param catch: if catch is true, check saved movie is suitable.
    :return: GitHub repository page URL
    """
    targets = targets.split(",")
    if len(url) == 0:
        raise HTTPException(status_code=400, detail="URL is empty.Please set URL.")
    bucket_manager = BucketManager(BUCKET_NAME)
    browser_config = BrowserConfig(url, width, height, page_height, scroll, targets=targets)
    movie_path = Path(f"movie/{browser_config.hash}.mp4")
    if catch and movie_path.exists():
        url = bucket_manager.get_public_file_url(str(movie_path))
        return {'url': url}
    # Download the repository.
    image_dir = MovieMaker.take_screenshots_github_files(browser_config)
    movie_config = MovieConfig(image_dir, movie_path, width=width)
    MovieMaker.image_to_movie(movie_config)
    # Upload to GCS
    url = BucketManager(BUCKET_NAME).to_public_url(str(movie_path))
    return {'url': url}
