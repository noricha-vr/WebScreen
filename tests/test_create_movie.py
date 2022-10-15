import os
from browser import Browser
from movie_maker import image_to_movie
import pytest


def test_make_movie():
    browser = Browser(1280, 720)
    paths = browser.take_screenshot("https://www.google.com", 100, 5000)
    assert len(paths) == 1
    output_path = "movie/test.mp4"
    image_to_movie(paths, output_path)
    assert os.path.exists(output_path) is True
    os.remove(output_path)
