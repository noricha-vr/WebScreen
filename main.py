import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from browser import Browser
from file_handler import FileHandler
from gcs import BucketManager
from fastapi.responses import HTMLResponse
from hash_maker import params_to_hash

app = FastAPI()
BUCKET_NAME = os.environ.get("BUCKET_NAME", None)


@app.get("/")
async def index():
    """
    This is usage of this API.
    :return: HTML
    """
    return HTMLResponse("""
    <h1>NorichaConverter</h1>
    <h2>VRChatで表示したいウェブページのURLを入力してください</h2>
    <form action="/create_movie" method="get">
        <input type="text" name="url" placeholder="https://">
        <input type="submit" value="Create Movie">
    </form>
    """)


@app.get("/create_movie/")
def create_movie(url: str, width: int = 720, height: int = 720, max_height: int = 10000):
    """
    Take a screenshot of the given URL. The screenshot is saved in the GCS. Return the file of download URL.
    1. create hash of URL, each_px, width, height. max_height.
    2. check if the movie file exists.
    3. if the movie file exists, return the download url.
    4. if the movie file does not exist, take a screenshot and save it to the GCS.
    :param url: URL to take a screenshot
    :param width: Browser width
    :param height: Browser height
    :param max_height: Max scroll height
    :return: Download URL
    """
    if len(url) == 0:
        raise HTTPException(status_code=400, detail="URL is empty.Please set URL.")
    bucket_manager = BucketManager(BUCKET_NAME)
    params_hash = params_to_hash(url, str(width), str(height), str(max_height))
    if FileHandler.movie_is_exists(params_hash):
        return bucket_manager.get_public_file_url(f"{params_hash}.mp4")
    each_px = 100
    browser = Browser(width, height)
    try:
        image_folder = browser.take_screenshot(url, each_px, max_height)
        # Create a movie
        # movie_path = f"{folder_path}/movie.mp4"
        # self.create_movie(file_paths, movie_path)
        # Upload to GCS
        # file_name = f'{folder_path.name}.mp4'
        # bucket_manager = BucketManager(BUCKET_NAME)
        # bucket_manager.upload_file(movie_path, file_name)
        # return file_name

        file_path = FileHandler.file_name_to_path(file_name)
        file_hash = FileHandler.file_to_hash(file_path)
        bucket_manager = BucketManager(BUCKET_NAME)
        bucket_manager.make_public(file_name)
        url = bucket_manager.get_public_file_url(file_name)
    except Exception as e:
        browser.driver.quit()
        print(e)
        return {'message': 'Error occurred.'}
        # return HTTPException(status_code=500, detail=str(e))
    return {'message': 'Success', 'file_name': file_name, 'file_hash': file_hash, 'url': url}


@app.get("/get_url/{file_name}/{file_hash}")
def get_url(file_name: str, file_hash: str):
    # file name to file path
    file_path = FileHandler.file_name_to_path(file_name)
    print(f'file_path: {file_path}')
    if FileHandler.file_to_hash(file_path) != file_hash:
        return {'message': 'File hash is not correct.'}
    bucket_manager = BucketManager(BUCKET_NAME)
    bucket_manager.make_public(file_name)
    gcs_file_url = bucket_manager.get_public_file_url(file_name)
    return {'message': 'Success', 'url': gcs_file_url}
