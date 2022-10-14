import hashlib
import os
import time
from pathlib import Path


class FileHandler:
    @staticmethod
    def movie_is_exists(file_hash: str) -> bool:
        """
        Check if the movie file exists.
        movie file is in movie folder.
        :param file_hash:
        :return: bool
        """
        movie_path = f"movie/{file_hash}.mp4"
        return os.path.exists(movie_path)

    @staticmethod
    def file_to_hash(file_path: Path) -> str:
        """
        Get file hash
        :param file_path:
        :return: file hash
        """
        with open(file_path, 'rb') as f:
            return hashlib.sha3_256(f'{f.read()}{file_path}'.encode('utf-8')).hexdigest()

    @staticmethod
    def delete_folder(folder_path: Path) -> None:
        """
        Delete folder
        :param folder_path:
        :return None:
        """
        import shutil
        shutil.rmtree(folder_path)

    @staticmethod
    def file_name_to_path(file_name: str) -> Path:
        """
        Get file path
        :param file_name:
        :return: file path
        """
        return Path(f"image/{Path(file_name).stem}/movie.mp4")
