import hashlib
from pathlib import Path
import zipfile

import requests


class FileHandler:
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

    @staticmethod
    def unzip_file(zip_file_path: Path, folder_path: Path) -> None:
        """
        Unzip file
        :param zip_file_path:
        :param folder_path:
        """
        with zipfile.ZipFile(zip_file_path) as existing_zip:
            existing_zip.extractall(folder_path)

    @staticmethod
    def download_file(url: str, file_path: Path) -> None:
        """
        Download git archive
        :param url:
        :param file_path:
        """
        response = requests.get(url)
        with open(file_path, 'wb') as f:
            f.write(response.content)
