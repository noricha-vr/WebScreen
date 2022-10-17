import os
import shutil
from pathlib import Path

from file_handler import FileHandler
import pytest
import glob

# rest image and movie folder.
for folder in glob.glob("image/*"): shutil.rmtree(folder)
for file in glob.glob("movie/*.mp4"): os.remove(file)
if not Path('tmp').exists(): shutil.rmtree('tmp')


class GithubMovieMaker:
    """
    Github class
    """

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


class TestGithubMovieMaker:

    @pytest.mark.parametrize(('url'), [
        ("https://github.com/noricha-vr/screen_capture"),
    ])
    def test_extract_zip_file(self, url):
        folder_path = GithubMovieMaker().download(url)
        assert folder_path.exists() is True
