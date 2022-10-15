import os
from browser import Browser
from hash_maker import params_to_hash
from movie_maker import image_to_movie
import pytest
import glob


def reset_folder():
    """Remove images and movies. The pattern is image/*.png and movie/*movie.mp4"""
    for file_path in glob.glob("image/*.png"):
        os.remove(file_path)
    for file_path in glob.glob("movie/*movie.mp4"):
        os.remove(file_path)


def test_reset_folder():
    reset_folder()
    assert not os.path.exists("image")


@pytest.mark.parametrize(('url', 'width', 'height', 'max_height', 'scroll_px', 'length'), [
    # ("https://www.google.com", 1280, 720, 5000, 100,1),
    ("https://forest.watch.impress.co.jp/docs/serial/sspcgame/1436345.html", 1280, 720, 5000, 300, 17),
    ("https://forest.watch.impress.co.jp/docs/serial/sspcgame/1436345.html", 1280, 720, 1000, 100, 5)
])
def test_make_movie(url, width, height, max_height, scroll_px, length):
    params_hash = params_to_hash(url, width, height, max_height, scroll_px)
    movie_path = f"movie/{params_hash}.mp4"
    browser = Browser(width, height, max_height, scroll_px)
    browser.open(url)
    paths = browser.take_screenshot()
    assert length == len(paths)
    image_to_movie(paths, movie_path)
    assert os.path.exists(movie_path) is True
