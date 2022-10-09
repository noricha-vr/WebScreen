from fastapi import FastAPI
from fastapi.responses import FileResponse
from browser import HeadlessDriverGenerator

app = FastAPI()

@app.get("/")
async def index():
    return {'message': 'Please set parameter. It is like "/?url=https://example.com"'}

@app.get("/screenshot")
def screenshot(url: str):
    driver = HeadlessDriverGenerator.get_headless_chromedriver()
    driver.get(url)
    driver.save_screenshot('screenshot.png')
    driver.quit()
    return FileResponse('screenshot.png')