from fastapi import APIRouter
import os
import shutil
import time
from uuid import uuid4
from datetime import datetime
from pathlib import Path
from typing import List
from fastapi import HTTPException, Request, UploadFile, Form, File
from movie_maker.movie_maker import BrowserConfig, MovieConfig, MovieMaker
from movie_maker.config import ImageConfig
from threading import Thread
from gcs import BucketManager
from models import BrowserSetting, GithubSetting
from util import pdf_to_image, to_m3u8, upload_hls_files, add_frames
from utils.setup_logger import get_logger

logger = get_logger(__name__)
DEBUG = os.getenv('DEBUG') == 'True'
BUCKET_NAME = os.environ.get("BUCKET_NAME", None)

ROOT_DIR = Path(os.path.dirname(__file__)).parent
STATIC_DIR = ROOT_DIR / "static"
MOVIE_DIR = ROOT_DIR / "movie"

router = APIRouter()


@router.get("/")
async def read_root():
    return {"message": "Hello World"}


@router.get("/items/{item_id}")
async def read_item(item_id: int, q: str = None):
    return {"item_id": item_id, "q": q}


@router.post("/url-to-movie/")
def url_to_movie(browser_setting: BrowserSetting) -> dict:
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
    scroll = int(browser_setting.height // 4)
    browser_config = BrowserConfig(browser_setting.url, browser_setting.width, browser_setting.height,
                                   browser_setting.page_height, scroll, lang=browser_setting.lang,
                                   wait_time=browser_setting.wait_time)
    logger.info(f"browser_config: {browser_config}")
    movie_path = Path(f"movie/{browser_config.hash}.mp4")
    # if movie_path.exists() and browser_setting.catch:
    #     url = bucket_manager.get_public_file_url(str(movie_path))
    #     return {'url': url, 'delete_at': None}
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


@router.post("/image-to-movie/")
async def image_to_movie(images: List[UploadFile] = File(...)) -> dict:
    """
    Merge images and create a movie.
    :param images: List of image files
    :return: Download URL
    """
    bucket_manager = BucketManager(BUCKET_NAME)
    name = str(uuid4())
    image_dir = Path('../image') / name
    image_dir.mkdir(exist_ok=True, parents=True)
    output_image_dir = Path('../image') / f'{name}_output'
    image_config = ImageConfig(image_dir, output_image_dir)
    movie_path = Path(f"movie/{name}.mp4")
    movie_path.parent.mkdir(exist_ok=True, parents=True)
    logger.info(f"image_dir: {image_dir.absolute()}")
    # Save image
    for image in images:
        image_path = str(image_dir.joinpath(image.filename).absolute())
        logger.info(f"image_path: {image_path}")
        with open(image_path, "wb") as buffer:
            shutil.copyfileobj(image.file, buffer)
    # Convert image size and save as PNG
    MovieMaker.format_images(image_config)
    movie_config = MovieConfig(output_image_dir, movie_path)
    MovieMaker.image_to_movie(movie_config)
    url = bucket_manager.to_public_url(str(movie_path))
    delete_at = datetime.now().timestamp() + 60 * 60 * 24 * 14
    return {'url': url, 'delete_at': delete_at}


@router.post('/pdf-to-movie/')
async def pdf_to_movie(pdf: UploadFile = File(), frame_sec: int = Form(...)) -> dict:
    """
    Convert PDF to movie.
    :param pdf: PDF file
    :param frame_sec: Frame par second
    :return: Download URL
    """
    bucket_manager = BucketManager(BUCKET_NAME)
    name = str(uuid4())
    image_dir = Path('../image') / name
    image_dir.mkdir(exist_ok=True, parents=True)
    movie_path = Path(f"movie/{name}.mp4")
    movie_path.parent.mkdir(exist_ok=True, parents=True)
    pdf_to_image(pdf.file.read(), image_dir)
    add_frames(image_dir, frame_sec)
    movie_config = MovieConfig(image_dir, movie_path, encode_speed='slow')
    MovieMaker.image_to_movie(movie_config)
    url = bucket_manager.to_public_url(str(movie_path))
    delete_at = datetime.now().timestamp() + 60 * 60 * 24 * 14
    return {'url': url, 'delete_at': delete_at}


@router.post("/save-movie/")
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


@router.post("/create_github_movie/")
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


@router.post("/stream/")
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
    movie_dir = Path(f"{MOVIE_DIR}/{uuid}")
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


@router.get("/delete-movie/")
def delete_movie() -> dict:
    """
    Delete movie files in movie directory. If file age is over 1 hour, delete the file.
    :return: message and deleted file list.
    """
    movie_dir = Path("../movie")
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