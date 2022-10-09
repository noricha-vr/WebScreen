from fastapi import FastAPI

from browser import Browser

app = FastAPI()


@app.get("/")
async def index():
    return {'message': 'Please set parameter. It is like "/?url=https://example.com"'}


@app.get("/screenshot/")
def screenshot(url: str):
    browser = Browser()
    file_paths = browser.take_screenshot(url)
    return {'urls': file_paths}
