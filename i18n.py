from fastapi_babel import Babel
from fastapi_babel import BabelCli
from fastapi_babel import BabelConfigs
from fastapi import Request
from utils.setup_logger import get_logger
from fastapi_babel import _

logger = get_logger(__name__)
DEFAULT_LANGUAGE = "en"
SUPPORTED_LANGUAGE = ["ja", "fa", "en", "zh", "ko"]


def get_lang(request: Request):
    lang = request.headers.get("Accept-Language", DEFAULT_LANGUAGE)
    lang = lang[:2]
    lang = DEFAULT_LANGUAGE if lang not in SUPPORTED_LANGUAGE else lang
    return lang


def check_trans(babel: Babel):
    langs = ['en', 'fa', 'ja', 'zh', 'ko']
    for lang in langs:
        babel.locale = "en"
        logger.info(f'{lang} - {_("Hello World")}')
        print(f'{lang} - {_("Hello World")}')


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
