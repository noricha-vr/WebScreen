import hashlib
from pathlib import Path


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
