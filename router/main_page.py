import os
from fastapi import APIRouter
from pathlib import Path
from fastapi import Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from utils.setup_logger import get_logger
from i18n import babel, check_trans

logger = get_logger(__name__)
DEBUG = os.getenv('DEBUG') == 'True'
ROOT_DIR = Path(os.path.dirname(__file__)).parent
templates = Jinja2Templates(directory=ROOT_DIR / "templates")
babel.install_jinja(templates)
router = APIRouter()


@router.get("/{lang}/web/", response_class=HTMLResponse)
async def redirect_web(request: Request, lang: str = Path(regex="^(ja|en)$")) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('web.html', {'request': request})


@router.get("/{lang}/pdf/")
async def redirect_pdf(request: Request, lang: str = Path(regex="^(ja|en)$")) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('pdf.html', {'request': request})


@router.get("/{lang}/image/")
async def redirect_image(request: Request, lang: str = Path(regex="^(ja|en)$")) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('image.html', {'request': request})


@router.get("/{lang}/recording/")
def redirect_recording(request: Request, lang: str = Path(regex="^(ja|en)$")) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('record.html', {'request': request})


@router.get("/{lang}/streaming/")
async def redirect_streaming(request: Request, lang: str = Path(regex="^(ja|en)$")) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('streaming.html', {'request': request})


@router.get("/{lang}/history/", response_class=HTMLResponse)
async def redirect_history(request: Request, lang: str = Path(regex="^(ja|en)$")) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('history.html', {'request': request})


@router.get("/{lang}/github/")
async def redirect_github(request: Request, lang: str = Path(regex="^(ja|en)$")) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('github.html', {'request': request})


@router.get("/{lang}/privacy")
async def privacy(request: Request, lang: str = Path(regex="^(ja|en)$")):
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse("privacy.html", {"request": request})


@router.get("/{lang}/", response_class=HTMLResponse)
async def redirect_home(request: Request, lang: str = Path(regex="^(ja|en)$")) -> templates.TemplateResponse:
    check_trans(babel)
    babel.locale = lang
    return templates.TemplateResponse('home.html', {'request': request})
