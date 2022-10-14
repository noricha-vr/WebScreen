import os
from unittest import TestCase
from browser import Browser
from movie_maker import create_movie


class TestCreateMovie(TestCase):
    def test_make_movie(self):
        browser = Browser(1280, 720)
        paths = browser.take_screenshot("https://www.google.com", 100, 5000)
        self.assertEqual(len(paths), 1)
        output_path = "movie/test.mp4"
        create_movie(paths, output_path)
        self.assertTrue(os.path.exists(output_path))
        os.remove(output_path)
