import os
import shutil
from pathlib import Path

from file_handler import FileHandler
import pytest
import glob

# rest image and movie folder.
for folder in glob.glob("image/*"): shutil.rmtree(folder)
for file in glob.glob("movie/*.mp4"): os.remove(file)
shutil.rmtree('repo')

class GithubMovieMaker:
    from pygments import highlight
    from pygments.lexers import PythonLexer
    from pygments.formatters import HtmlFormatter

    def path_to_html_path(file_path: Path) -> Path:
        """
        Convert file path to html path. Rname file path of 'tmp' to 'html' and file suffix to .html.
        :param file_path:
        :return: html_path
        """
        return Path(f"html/{file_path.parent.stem}/{file_path.stem}.html")


    def sourcer_to_html(file_path,html_root)->Path:
        """
        Convert sourcer to html
        :param file_path:
        :param html_root:
        :return: html_file_path
        """
        html_file_path = html_root / f"{file_path.stem}.html"
        with open(file_path) as f:
            with open(html_file_path, 'w') as f2:
                f2.write(GithubMovieMaker.highlight(f.read(), PythonLexer(), HtmlFormatter()))
        return html_file_path

@pytest.mark.parametrize(('url'), [
    ("https://github.com/noricha-vr/screen_capture"),
])
def test_extract_zip_file(url):
    download_url = f'{url}/archive/master.zip'
    project_name = url.split('/')[-1]
    zip_path = Path(f"repo/{project_name}.zip")
    os.mkdir(zip_path.parent)
    FileHandler.download_file(download_url, zip_path)
    assert zip_path.exists()
    FileHandler.unzip_file(zip_path, zip_path.parent)
    folder_path = zip_path.parent.glob(f"{project_name}-*").__next__()
    assert folder_path.exists() is True

def test_path_to_html_path():
    file_path = Path('repo/screen_capture-0d3b3a1/screen_capture.py')
    html_path = GithubMovieMaker.path_to_html_path(file_path)
    assert html_path == Path('html/screen_capture/screen_capture.html')

def test_source_code_to_html():
    folder_path = Path('repo/screen_capture-0d3b3a1')
    assert FileHandler.file_to_hash(folder_path) == '0d3b3a1'