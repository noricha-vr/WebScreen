import hashlib


def params_to_hash(*args):
    """
    Get hash from params
    :param args:
    :return: hash
    """
    return hashlib.sha3_256(''.join(args).encode('utf-8')).hexdigest()
