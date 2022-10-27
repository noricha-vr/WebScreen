import logging
import os
import shutil
import time
from pathlib import Path
from typing import List, Union

from fastapi import FastAPI, HTTPException, File, UploadFile, Header
from starlette.responses import RedirectResponse, FileResponse
from gcs import BucketManager
from movie_maker import MovieMaker, MovieConfig

logger = logging.getLogger('uvicorn')
BUCKET_NAME = os.environ.get("BUCKET_NAME", None)
STATIC_DIR = Path(os.path.join(os.path.dirname(__file__), "static"))

app = FastAPI()


@app.get("/")
async def read_index():
    return FileResponse((STATIC_DIR / 'index.html'))


@app.get("/image/")
async def read_index():
    return FileResponse((STATIC_DIR / 'image.html'))


@app.get("/desktop/")
async def read_index():
    return FileResponse((STATIC_DIR / 'desktop.html'))


@app.get("/github")
async def read_index():
    return FileResponse((STATIC_DIR / 'github.html'))


@app.get("/api/create_movie/")
def create_movie(url: str, width: int = 1280, height: int = 720, limit_height: int = 50000, scroll_each: int = 200):
    """
    Take a screenshot of the given URL. The screenshot is saved in the GCS. Return the file of download URL.
    1. create hash of URL, scroll_px, width, height. max_height.
    2. check if the movie file exists.
    3. if the movie file exists, return the download url.
    4. if the movie file does not exist, take a screenshot and save it to the GCS.
    :param url: URL to take a screenshot
    :param width: Browser width
    :param height: Browser height
    :param limit_height: Max scroll height
    :param scroll_each:
    :return: Download URL
    """
    if len(url) == 0:
        raise HTTPException(status_code=400, detail="URL is empty.Please set URL.")
    bucket_manager = BucketManager(BUCKET_NAME)
    movie_config = MovieConfig(url, width, height, limit_height, scroll_each)
    if os.path.exists(movie_config.movie_path):
        url = bucket_manager.get_public_file_url(movie_config.movie_path)
        return RedirectResponse(url=url, status_code=303)
    movie_maker = MovieMaker(movie_config)
    movie_maker.create_movie()
    if BUCKET_NAME is None: return FileResponse(movie_config.movie_path)
    # Upload to GCS
    url = BucketManager(BUCKET_NAME).to_public_url(movie_config.movie_path)
    return RedirectResponse(url=url, status_code=303)


@app.post("/api/create_image_movie/")
async def create_image_movie(files: List[UploadFile], width: int = 1280, height: int = 720,
                             limit_height: int = 50000, scroll_each: int = 200):
    """
    Merge images and create a movie.
    :param files: List of image files
    :param width: Browser width
    :param height: Browser height
    :param limit_height: Max scroll height
    :param scroll_each:
    :return: Download URL
    """
    bucket_manager = BucketManager(BUCKET_NAME)
    movie_config = MovieConfig("", width, height, limit_height, scroll_each)
    movie_maker = MovieMaker(movie_config)
    image_paths = []
    image_dir = Path('image')
    image_dir.mkdir(exist_ok=True)
    print(f"image_dir: {image_dir.absolute()}")
    for f in files:
        image_path = str(image_dir.joinpath(f.filename).absolute())
        print(f"image_path: {image_path}")
        image_paths.append(image_path)
        with open(image_path, "wb") as buffer:
            shutil.copyfileobj(f.file, buffer)
    movie_maker.image_to_movie(image_paths, movie_config.movie_path)
    if BUCKET_NAME is None: return FileResponse(movie_config.movie_path)
    url = bucket_manager.to_public_url(movie_config.movie_path)
    return RedirectResponse(url=url, status_code=303)


@app.get("/api/desktop/{session_id}/")
def get_desktop(session_id: str):
    """
    Get movie which file name is 'movie/{session_id}.mp4.
    :param session_id:
    :return: movie file
    """
    movie_path = f"movie/{session_id}.mp4"
    for i in range(3):
        if os.path.exists(movie_path): return FileResponse(movie_path)
        time.sleep(1)
    raise HTTPException(status_code=404, detail="Movie file does not exist.")


@app.post("/api/desktop/")
def post_desktop(file: UploadFile = File(...), x_token: Union[List[str], None] = Header(default=None)):
    """
    Upload image file and convert to mp4. Movie file is saved in 'movie/{session_id}.mp4'. Header has `session_id`.
    :param file: image file
    :return: message
    """
    if x_token is None:
        raise HTTPException(status_code=400, detail="session_id is empty.")
    token = x_token[0]
    movie_path = f"movie/{token}.mp4"
    temp_movie_path = f"movie/{token}_temp.mp4"
    image_path = f"image/{token}.jpg"
    with open(image_path, "wb") as f: f.write(file.file.read())
    MovieMaker.image_to_movie([image_path], temp_movie_path)
    os.rename(temp_movie_path, movie_path)
    return {"message": f"success. URL: /api/desktop/{token}/"}


@app.get("/api/create_github_movie/")
def create_github_movie(url: str, targets: str, width: int = 1280, height: int = 720, limit_height: int = 50000,
                        scroll_each: int = 200,
                        catch: bool = True):
    """
    Download github repository, convert file into HTML, and take a screenshot.
    :param url: URL to take a screenshot
    :param targets: target file list to take a screenshot
    :param width: Browser width
    :param height: Browser height
    :param limit_height: Max scroll height
    :param scroll_each:
    :param catch: if catch is true, check saved movie is suitable.
    :return: GitHub repository page URL
    """
    targets = targets.split(",")
    if len(url) == 0:
        raise HTTPException(status_code=400, detail="URL is empty.Please set URL.")
    bucket_manager = BucketManager(BUCKET_NAME)
    movie_config = MovieConfig(url, width, height, limit_height, scroll_each, targets)
    if catch and os.path.exists(movie_config.movie_path):
        url = bucket_manager.get_public_file_url(movie_config.movie_path)
        return RedirectResponse(url=url, status_code=303)
    # Download the repository.
    movie_maker = MovieMaker(movie_config)
    movie_maker.create_github_movie()
    if BUCKET_NAME is None: return FileResponse(movie_config.movie_path)
    # Upload to GCS
    url = BucketManager(BUCKET_NAME).to_public_url(movie_config.movie_path)
    return RedirectResponse(url=url, status_code=303)
