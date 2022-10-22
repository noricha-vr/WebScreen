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
        self.scroll_height = None
        self.folder_path = self.create_folder()
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
        folder_path = f"image/{timestamp}"
        os.makedirs(folder_path)
        return Path(folder_path)

    def to_scroll_height(self, scroll_limit: int, scroll_px: int) -> int:
        """
        Calculate scroll height.
        :param scroll_limit:
        :param scroll_px:
        :return scroll_height:
        """
        page_height = self.driver.execute_script("return document.body.scrollHeight")
        scroll_height = page_height - self.movie_config.height
        if scroll_height > scroll_limit: scroll_height = scroll_limit  # Limit scroll height
        if scroll_height == 0: scroll_height = scroll_px  # Set minimum scroll height, for run forloop once.
        print(f"Scroll height: {scroll_height}")
        return scroll_height

    def _get_page_no(self) -> str:
        """
        Get page number. for example: 001, 002, 003, ...
        :return: page number.
        """
        return str(self.page_no).zfill(3)

    def open(self, url: str) -> None:
        """open url and set scroll_height"""
        self.driver.get(url)
        print(f"Open url: {url}")
        self.scroll_height = self.to_scroll_height(self.movie_config.max_height, self.movie_config.scroll_px)

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
