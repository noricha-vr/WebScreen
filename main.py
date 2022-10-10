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
        gcs_file_url = browser.take_screenshot(url, each_px, max_height)
    except Exception as e:
        browser.driver.quit()
        return HTTPException(status_code=500, detail=str(e))
    return {'message': 'Success', 'gcs_file_url': gcs_file_url}
