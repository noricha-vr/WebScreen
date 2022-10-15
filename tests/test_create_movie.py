import os
from browser import Browser
from movie_maker import image_to_movie
import pytest


@pytest.mark.parametrize(('url', 'length'), [
    ("https://www.google.com", 1),
    ("https://www.yahoo.com", 50)])
def test_make_movie(url, length):
    browser = Browser(1280, 720)
    paths = browser.take_screenshot(url, 100, 5000)
    assert len(paths) == length
    output_path = "movie/test.mp4"
    image_to_movie(paths, output_path)
    assert os.path.exists(output_path) is True
    os.remove(output_path)
