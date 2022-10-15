import os
from browser import Browser
from hash_maker import params_to_hash
from movie_maker import image_to_movie
import pytest
from moviepy import editor


@pytest.mark.parametrize(('url', 'width', 'height', 'max_height', 'scroll_px', 'length'), [
    ("https://www.google.com", 1280, 720, 5000, 100, 1),  # No scroll page test.
    ("https://forest.watch.impress.co.jp/docs/serial/sspcgame/1436345.html", 720, 1280, 5000, 500, 10),  # change sizes
    ("https://gigazine.net/news/20221012-geforce-rtx-4090-benchmark/", 2000, 2000, 1000, 100, 5)  # limit test
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
    movie = editor.VideoFileClip(movie_path)
    assert length == movie.duration
    assert movie.w == width
    assert movie.h == height
