from fastapi import Request

from utils.i18n import active_translation


def add_middlewares(app):
    @app.middleware("http")
    async def get_accept_language(request: Request, call_next):
        active_translation(request.headers.get("accept-language", None))
        response = await call_next(request)
        return response
