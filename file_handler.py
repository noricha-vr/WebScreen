import hashlib
import time
from pathlib import Path


class FileHandler:
    @staticmethod
    def file_to_hash(file_path: str) -> str:
        """
        Get file hash
        :param file_path:
        :return: file hash
        """
        with open(file_path, 'rb') as f:
            return hashlib.sha3_256(f'{f.read()}{time.time()}'.encode('utf-8')).hexdigest()

    @staticmethod
    def delete_folder(folder_path: Path) -> None:
        """
        Delete folder
        :param folder_path:
        :return None:
        """
        import shutil
        shutil.rmtree(folder_path)
