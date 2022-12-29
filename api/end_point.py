from fastapi import APIRouter

from utils.i18n import trans

router = APIRouter()


@router.get("/")
def home():
    return trans("Hello World")


api_router = APIRouter()
api_router.include_router(router, tags=["main"])
