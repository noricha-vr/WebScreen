import hashlib


def params_to_hash(url: str, width: int, height: int, max_height: int, scroll_px: int) -> str:
    """
    Get hash from params
    :param url:
    :param width:
    :param height:
    :param max_height:
    :param scroll_px:
    :return: hash
    """
    return hashlib.sha3_256(f'{url}{width}{height}{max_height}{scroll_px}'.encode('utf-8')).hexdigest()
