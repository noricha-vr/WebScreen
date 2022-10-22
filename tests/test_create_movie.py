import os
import shutil

from browser_creator import BrowserCreator
from movie_config import MovieConfig
from movie_maker import MovieMaker
import pytest
from moviepy import editor
import glob

# Rest image and movie folder.
for folder in glob.glob("image/*"): shutil.rmtree(folder)
for file in glob.glob("movie/*.mp4"): os.remove(file)


@pytest.mark.parametrize(('url', 'width', 'height', 'max_height', 'scroll_px', 'length'), [
    ("https://www.google.com", 1280, 720, 5000, 100, 1),  # No scroll page test.
    ("https://twitter.com/search?q=vrchat&src=typed_query", 1280, 720, 5000, 100, 25),  # Twitter test.
    ("https://forest.watch.impress.co.jp/docs/serial/sspcgame/1436345.html", 720, 1280, 5000, 500, 10),  # Change sizes
    ("https://gigazine.net/news/20221012-geforce-rtx-4090-benchmark/", 2000, 2000, 1000, 100, 5),  # Limit test
])
def test_create_movie(url, width, height, max_height, scroll_px, length):
    # Create movie.
    movie_config = MovieConfig(url, width, height, max_height, scroll_px)
    browser = BrowserCreator(movie_config).create_browser()
    browser.open(url)
    paths = browser.take_screenshot()
    browser.driver.quit()
    MovieMaker.image_to_movie(paths, movie_config.movie_path)
    # Check movie.
    movie = editor.VideoFileClip(movie_config.movie_path)
    if width > 1920: width = 1920
    if height > 1920: height = 1920
    assert length == movie.duration
    assert movie.w == width
    assert movie.h == height


class TestMovieMaker:
    @pytest.mark.parametrize(('url', 'targets'), [
        ('https://github.com/noricha-vr/source_converter', ['*.py', '*.md']),
    ])
    def test_create_github_movie(self, url, targets):
        movie_config = MovieConfig(url, 1280, 720, 5000, 100, targets=targets)
        movie_path = MovieMaker(movie_config).create_github_movie()
        movie = editor.VideoFileClip(movie_path)
        assert movie.duration == 14.0
        assert movie.w == 1280
        assert movie.h == 720

    def test_open_local_html_file(self, ):
        url = "file:///opt/project/tests/html/source_converter/github_downloader.html"
        movie_config = MovieConfig(url)
        browser = BrowserCreator(movie_config).create_browser()
        browser.open(url)
        paths = browser.take_screenshot()
        MovieMaker.image_to_movie(paths, movie_config.movie_path)
        movie = editor.VideoFileClip(movie_config.movie_path)
        assert movie.duration == 4.0
