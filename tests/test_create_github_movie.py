import os
import shutil
from pathlib import Path

from file_handler import FileHandler
import pytest
import glob

# rest image and movie folder.
for folder in glob.glob("image/*"): shutil.rmtree(folder)
for file in glob.glob("movie/*.mp4"): os.remove(file)
shutil.rmtree('tmp')


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
        os.mkdir(zip_path.parent)
        FileHandler.download_file(download_url, zip_path)
        FileHandler.unzip_file(zip_path, zip_path.parent)
        folder_path = zip_path.parent.glob(f"{project_name}-*").__next__()
        return folder_path


@pytest.mark.parametrize(('url'), [
    ("https://github.com/noricha-vr/screen_capture"),
])
def test_extract_zip_file(url):
    folder_path = GithubMovieMaker().download(url)
    assert folder_path.exists() is True
