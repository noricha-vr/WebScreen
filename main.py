from fastapi import FastAPI, HTTPException

from browser import Browser

app = FastAPI()


@app.get("/")
async def index():
    return {'message': 'Please set parameter. It is like "/?url=https://example.com"'}


@app.get("/screenshot/")
def screenshot(url: str, each_px: int = 300, max_height: int = 5000):
    browser = Browser()
    try:
        file_paths = browser.take_screenshot(url, each_px, max_height)
        return {'message': 'Success', 'file_paths': file_paths}
    except Exception as e:
        browser.driver.quit()
        return HTTPException(status_code=500, detail=str(e))
