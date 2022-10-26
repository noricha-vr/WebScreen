import os
import shutil
from pathlib import Path
from typing import List

from fastapi import FastAPI, HTTPException, File, UploadFile
from starlette.responses import RedirectResponse, FileResponse
from gcs import BucketManager
from movie_maker import MovieMaker, MovieConfig

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
    return FileResponse((STATIC_DIR / 'index.html'))


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
    url = bucket_manager.to_public_url(movie_config.movie_path)
    return RedirectResponse(url=url, status_code=303)


@app.get("/desktop/{session_id}/")
def get_desktop(session_id: str):
    """
    Get movie which file name is 'movie/{session_id}.mp4.
    :param session_id:
    :return: movie file
    """
    movie_path = f"movie/{session_id}.mp4"
    if not os.path.exists(movie_path):
        raise HTTPException(status_code=404, detail="Movie file does not exist.")
    return FileResponse(movie_path)


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
    # Upload to GCS
    url = BucketManager(BUCKET_NAME).to_public_url(movie_config.movie_path)
    return RedirectResponse(url=url, status_code=303)
