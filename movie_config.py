import hashlib
import logging.config
from pathlib import Path
from typing import List

logging.config.fileConfig('logging.conf')
logger = logging.getLogger(__name__)


class MovieConfig:
    def __init__(self, url, width: int = 1280, height: int = 720, limit_height: int = 50000, scroll_each: int = 200,
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
        self.movie_path = Path(f"movie/{self.params_hash}.mp4")
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
        logger.info(f"MovieConfig: {self.__dict__}")

    def set_scroll_height(self, page_height: int) -> None:
        """
        Calculate and set scroll height.
        :param page_height:
        """
        self.scroll_height = page_height - self.height
        if self.scroll_height > self.limit_height: self.scroll_height = self.limit_height
        self.scroll_height += self.scroll_each  # add scroll each
        print(f"Scroll height: {self.scroll_height}")
