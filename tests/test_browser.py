from unittest import TestCase
from browser import Browser


class TestBrowser(TestCase):
    def test_take_screenshot(self):
        browser = Browser(1280, 720)
        paths = browser.take_screenshot("https://www.google.com", 100, 5000)
        self.assertEqual(len(paths), 1)
