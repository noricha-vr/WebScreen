import hashlib
from typing import List


class MovieConfig:
    def __init__(self, url, width: int = 1280, height: int = 720, limit_height: int = 5000, scroll_each: int = 200,
                 targets: List[str] = None):
        self.scroll_height = None
        self.url = url
        self.domain = url.split("/")[2]
        self.width = width
        self.height = height
        self.limit_height = limit_height
        self.scroll_each = scroll_each
        self.targets = targets
        self.params_hash = self.params_to_hash()
        self.movie_path = f"movie/{self.params_hash}.mp4"
        self.apply_limit()

    def params_to_hash(self):
        text = f"{self.url}{self.width}{self.height}{self.limit_height}{self.scroll_each}{str(self.targets)}".encode()
        return hashlib.sha3_256(text).hexdigest()

    def apply_limit(self):
        limit_minimum_scroll = 200
        limit_max_height = 100000
        limit_width = 1920
        limit_height = 1920
        if self.width > limit_width: self.width = limit_width
        if self.height > limit_height: self.height = limit_height
        if self.limit_height > limit_max_height: self.limit_height = limit_max_height
        if self.scroll_each < limit_minimum_scroll: self.scroll_each = limit_minimum_scroll

    def set_scroll_height(self, page_height: int):
        self.scroll_height = page_height - self.height
        if self.scroll_height > self.limit_height: self.scroll_height = self.limit_height

        # def to_scroll_height(self, scroll_limit: int, scroll_px: int) -> int:

        """
        Calculate scroll height.
        :param scroll_limit:
        :param scroll_px:
        :return scroll_height:
        """
        scroll_height = page_height - self.height
        if scroll_height > self.limit_height: scroll_height = self.limit_height  # Limit scroll height
        if scroll_height == 0: scroll_height = self.scroll_each  # Set minimum scroll height, for run forloop once.
        print(f"Scroll height: {scroll_height}")
        return scroll_height
