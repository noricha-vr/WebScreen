from fastapi import FastAPI

from browser import Browser

app = FastAPI()


@app.get("/")
async def index():
    return {'message': 'Please set parameter. It is like "/?url=https://example.com"'}


@app.get("/screenshot/")
def screenshot(url: str, file_name: str = None, each_px: int = 300, max_height: int = 5000):
    browser = Browser()
    file_paths = browser.take_screenshot(url, file_name, each_px, max_height)
    return {'urls': file_paths}
