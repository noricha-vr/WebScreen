import os
import time
from pathlib import Path
from typing import List

from headless_driver import create_headless_chromedriver

BUCKET_NAME = os.environ.get("BUCKET_NAME", None)


class Browser:
    def __init__(self, width: int = 1280, height: int = 720, max_height: int = 5000, scroll_px: int = 200):
        self.scroll_px = scroll_px
        self.max_height = max_height
        self.scroll_height = None
        self.folder_path = None
        self.width = width
        self.height = height
        self.apply_limit()
        self.driver = create_headless_chromedriver(width, height)
        self.driver.implicitly_wait(10)

    def apply_limit(self):
        limit_minimum_scroll = 200
        limit_max_height = 100000
        limit_width = 1920
        limit_height = 1920
        if self.width > limit_width: self.width = limit_width
        if self.height > limit_height: self.height = limit_height
        if self.max_height > limit_max_height: self.max_height = limit_max_height
        if self.scroll_px < limit_minimum_scroll: self.scroll_px = limit_minimum_scroll

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
        scroll_height = page_height - self.height
        if scroll_height > scroll_limit: scroll_height = scroll_limit  # Limit scroll height
        if scroll_height == 0: scroll_height = scroll_px  # Set minimum scroll height, for run forloop once.
        print(f"Scroll height: {scroll_height}")
        return scroll_height

    def open(self, url: str) -> None:
        """open url and set scroll_height"""
        self.driver.get(url)
        print(f"URL: {url}")
        self.folder_path = self.create_folder()
        self.scroll_height = self.to_scroll_height(self.max_height, self.scroll_px)

    def take_screenshot(self) -> List[str]:
        """
        Take a screenshot of the given URL scrolling each px and returns image_file_paths.
        :return: image_file_paths:
        """
        file_paths = []
        # Take screenshots
        for px in range(0, self.scroll_height, self.scroll_px):
            self.driver.execute_script(f"window.scrollTo(0, {px})")
            file_path = f"{self.folder_path}/{px}.png"
            self.driver.save_screenshot(file_path)
            file_paths.append(file_path)
        self.driver.quit()
        return file_paths
