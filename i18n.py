from fastapi_babel import Babel
from fastapi_babel import BabelCli
from fastapi_babel import BabelConfigs

from fastapi import Request

DEFAULT_LANGUAGE = "en"
SUPPORTED_LANGUAGE = ["ja", "fa", "en", "zh", "ko"]


def get_lang(request: Request):
    lang = request.headers.get("Accept-Language", DEFAULT_LANGUAGE)
    lang = lang[:2]
    lang = DEFAULT_LANGUAGE if lang not in SUPPORTED_LANGUAGE else lang
    return lang


babel = Babel(
    configs=BabelConfigs(
        ROOT_DIR=__file__,
        BABEL_DEFAULT_LOCALE="ja",
        BABEL_TRANSLATION_DIRECTORY="lang",
    )
)

if __name__ == "__main__":
    babel_cli = BabelCli(babel_instance=babel)
    babel_cli.run()
