import os
import time
from pathlib import Path
from typing import List

from headless_driver import create_headless_chromedriver

BUCKET_NAME = os.environ.get("BUCKET_NAME", None)


class Browser:
    def __init__(self, width: int = 1280, height: int = 720, each_px: int = 100, max_height: int = 5000, ):
        if each_px < 50: each_px = 50  # Set minimum each_px, for run forloop once.
        self.each_px = each_px
        self.max_height = max_height
        self.scroll_height = None
        self.folder_path = None
        self.height = height
        self.driver = create_headless_chromedriver(width, height)
        self.driver.implicitly_wait(10)

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

    def to_scroll_height(self, max_height: int, each_px: int) -> int:
        """
        Calculate scroll height.
        :param max_height:
        :param each_px:
        :return scroll_height:
        """
        page_height = self.driver.execute_script("return document.body.scrollHeight")
        scroll_height = page_height - self.height
        if scroll_height > max_height:
            scroll_height = max_height  # Limit scroll height to max_height
        if scroll_height == 0: scroll_height = each_px  # Set minimum scroll height, for run forloop once.
        print(f"Scroll height: {scroll_height}")
        return scroll_height

    def open(self, url: str) -> None:
        """open url and set scroll_height"""
        self.driver.get(url)
        print(f"URL: {url}")
        self.folder_path = self.create_folder()
        self.scroll_height = self.to_scroll_height(self.max_height, self.each_px)

    def take_screenshot(self) -> List[str]:
        """
        Take a screenshot of the given URL scrolling each px and returns image_file_paths.
        :return: image_file_paths:
        """
        file_paths = []
        # Take screenshots
        for px in range(0, self.scroll_height, self.each_px):
            self.driver.execute_script(f"window.scrollTo(0, {px})")
            file_path = f"{self.folder_path}/{px}.png"
            self.driver.save_screenshot(file_path)
            file_paths.append(file_path)
        self.driver.quit()
        return file_paths
