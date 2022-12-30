import logging


def get_logger(name):
    logging.basicConfig()
    formatter = logging.Formatter(f'[%(levelname)s] %(asctime)s %(pathname)s:%(lineno)d - %(message)s')
    logger = logging.getLogger('uvicorn')
    handler = logging.StreamHandler()
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    return logger
