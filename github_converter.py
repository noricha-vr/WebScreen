import os
from pathlib import Path

from file_handler import FileHandler


class RepositoryHtmlConverter:
    """
    Github class
    """

    def __init__(self, source_folder_path: Path):


    def download(self, url) -> Path:
        """
        Download git archive and unzip it. return the folder path.
        Download git archive
        :return: folder path
        """
        download_url = f'{url}/archive/master.zip'
        project_name = url.split('/')[-1]
        zip_path = Path(f"tmp/{project_name}.zip")
        os.makedirs(zip_path.parent, exist_ok=True)
        FileHandler.download_file(download_url, zip_path)
        FileHandler.unzip_file(zip_path, zip_path.parent)
        folder_path = self.get_unzip_folder_path(zip_path)
        return folder_path

    @staticmethod
    def get_unzip_folder_path(zip_path):
        """
        Get unzip folder path
        :param zip_path:
        :return: unzip folder path
        """
        return zip_path.parent.glob(f"{zip_path.stem}-*").__next__()

