from fastapi import APIRouter
import os
import shutil
import time
from uuid import uuid4
from datetime import datetime
from pathlib import Path
from typing import List
from fastapi import HTTPException, Request, UploadFile, Form, File
from movie_maker import BrowserConfig, MovieConfig, MovieMaker
from movie_maker.config import ImageConfig
from threading import Thread
from gcs import BucketManager
from models import BrowserSetting, GithubSetting
from util import pdf_to_image, to_m3u8, upload_hls_files, add_frames
from utils.setup_logger import get_logger
import os
from datetime import datetime
from pathlib import Path
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import api
from gcs import BucketManager
from utils.setup_logger import get_logger
from utils.i18n import get_lang
from i18n import babel, check_trans
from fastapi_babel.middleware import InternationalizationMiddleware as I18nMiddleware

logger = get_logger(__name__)
DEBUG = os.getenv('DEBUG') == 'True'
BUCKET_NAME = os.environ.get("BUCKET_NAME", None)

ROOT_DIR = Path(os.path.dirname(__file__))
STATIC_DIR = ROOT_DIR / "static"
MOVIE_DIR = ROOT_DIR / "movie"
templates = Jinja2Templates(directory=ROOT_DIR / "templates")
babel.install_jinja(templates)
router = APIRouter()


@router.get("/{lang}/", response_class=HTMLResponse)
async def redirect_home(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('home.html', {'request': request})


@router.get("/{lang}/web/", response_class=HTMLResponse)
async def redirect_web(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('web.html', {'request': request})


@router.get("/{lang}/pdf/")
async def redirect_pdf(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('pdf.html', {'request': request})


@router.get("/{lang}/image/")
async def redirect_image(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('image.html', {'request': request})


@router.get("/{lang}/recording/")
def redirect_recording(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('record.html', {'request': request})


@router.get("/{lang}/streaming/")
async def redirect_streaming(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('streaming.html', {'request': request})


@router.get("/{lang}/history/", response_class=HTMLResponse)
async def redirect_history(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('history.html', {'request': request})


@router.get("/{lang}/github/")
async def redirect_github(request: Request, lang: str) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('github.html', {'request': request})


@router.get("/{lang}/privacy")
async def privacy(request: Request, lang: str):
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse("privacy.html", {"request": request})
