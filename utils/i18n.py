from fastapi import Request

DEFAULT_LANGUAGE = "en"
SUPPORTED_LANGUAGE = ["ja", "en"]


def get_lang(request: Request):
    lang = request.headers.get("Accept-Language", DEFAULT_LANGUAGE)
    lang = lang[:2]
    lang = DEFAULT_LANGUAGE if lang not in SUPPORTED_LANGUAGE else lang
    return lang
