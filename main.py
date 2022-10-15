import os

from fastapi import FastAPI, HTTPException
from starlette.responses import RedirectResponse

from browser_creator import BrowserCreator
from file_handler import FileHandler
from gcs import BucketManager
from fastapi.responses import HTMLResponse
from hash_maker import params_to_hash
from movie_maker import image_to_movie

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
def create_movie(url: str, width: int = 1280, height: int = 720, max_height: int = 10000, scroll_px: int = 200):
    """
    Take a screenshot of the given URL. The screenshot is saved in the GCS. Return the file of download URL.
    1. create hash of URL, scroll_px, width, height. max_height.
    2. check if the movie file exists.
    3. if the movie file exists, return the download url.
    4. if the movie file does not exist, take a screenshot and save it to the GCS.
    :param url: URL to take a screenshot
    :param width: Browser width
    :param height: Browser height
    :param max_height: Max scroll height
    :param scroll_px:
    :return: Download URL
    """
    if len(url) == 0:
        raise HTTPException(status_code=400, detail="URL is empty.Please set URL.")
    bucket_manager = BucketManager(BUCKET_NAME)
    params_hash = params_to_hash(url, width, height, max_height, scroll_px)
    movie_path = f"movie/{params_hash}.mp4"
    if os.path.exists(movie_path):
        url = bucket_manager.get_public_file_url(movie_path)
        return RedirectResponse(url=url, status_code=303)
    domain = url.split("/")[2]
    browser = BrowserCreator(domain, width, height, max_height, scroll_px).create_browser()
    browser.open(url)
    try:
        image_paths = browser.take_screenshot()
        # Create a movie
    except Exception as e:
        browser.driver.quit()
        print(e)
        return {'message': 'Error occurred.'}
        # return HTTPException(status_code=500, detail=str(e))
    image_to_movie(image_paths, movie_path)
    # Upload to GCS
    bucket_manager = BucketManager(BUCKET_NAME)
    bucket_manager.upload_file(movie_path, movie_path)
    bucket_manager.make_public(movie_path)
    url = bucket_manager.get_public_file_url(movie_path)
    return RedirectResponse(url=url, status_code=303)


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
