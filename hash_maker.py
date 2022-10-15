import hashlib


def params_to_hash(url: str, width: int, height: int, max_height: int, scroll_px: int) -> str:
    """
    Get hash from params
    :param scroll_px:
    :param max_height:
    :param height:
    :param width:
    :param url:
    :return: hash
    """
    return hashlib.sha3_256(f'{url}{width}{height}{max_height}'.encode('utf-8')).hexdigest()
