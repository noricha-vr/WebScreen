import gettext

_default_lang = None
DEFAULT_LANGUAGE = "en"
SUPPORTED_LANGUAGE = ["ja", "en", "zh", "ko"]


def active_translation(lang: str):
    global _default_lang
    _default_lang = (
        DEFAULT_LANGUAGE if lang not in SUPPORTED_LANGUAGE else lang
    )


def trans(message: str) -> str:
    return gettext.translation(
        "base", localedir="locales", languages=[_default_lang]
    ).gettext(message)
