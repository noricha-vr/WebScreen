import os
import time
from pathlib import Path
from typing import List

from headless_driver import create_headless_chromedriver
import abc

from movie_config import MovieConfig


class BaseBrowser(metaclass=abc.ABCMeta):

    def __init__(self, movie_config: MovieConfig):
        self.movie_config = movie_config
        self.image_folder_path = self.create_folder()
        self.driver = create_headless_chromedriver(movie_config.width, movie_config.height)
        self.driver.implicitly_wait(10)
        self.page_no = 0

    @staticmethod
    def create_folder() -> Path:
        """
        Create folder named by timestamp
        :return: Path object
        """
        timestamp = str(time.time())[0:10]
        image_folder_path = f"image/{timestamp}"
        os.makedirs(image_folder_path)
        return Path(image_folder_path)

    def set_scroll_height(self) -> None:
        """
        Calculate scroll height.
        """
        page_height = self.driver.execute_script("return document.body.scrollHeight")
        self.movie_config.set_scroll_height(page_height)

    def _get_page_no(self) -> str:
        """
        Get page number. for example: 001, 002, 003, ...
        :return: page number.
        """
        return str(self.page_no).zfill(3)

    def open(self, url: str) -> None:
        """open url and set scroll_height"""
        print(f"Open url: {url}")
        self.driver.get(url)
        self.set_scroll_height()

    @abc.abstractmethod
    def take_screenshot(self) -> List[str]:
        """
        Take a screenshot of the given URL scrolling each px and returns image_file_paths.
        :return: image_file_paths:
        """

    # Is this method necessary?
    # @abc.abstractmethod
    # def take_screenshots(self, urls: List[str]) -> List[str]:
    #     """
    #     Take a screenshot of the given URLs returns image_file_paths.
    #     :param urls:
    #     :return: image_file_paths:
    #     """
