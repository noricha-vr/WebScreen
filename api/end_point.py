from fastapi import APIRouter

router = APIRouter()


@router.get("/")
def home():
    return {"Hello": "world"}


api_router = APIRouter()
api_router.include_router(router, tags=["main"])
