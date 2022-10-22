import hashlib
from typing import List


class MovieConfig:
    def __init__(self, url, width: int = 1280, height: int = 720, max_height: int = 5000, scroll_px: int = 200,
                 targets: List[str] = None):
        self.url = url
        self.domain = url.split("/")[2]
        self.width = width
        self.height = height
        self.max_height = max_height
        self.scroll_px = scroll_px
        self.targets = targets
        self.params_hash = self.params_to_hash()
        self.movie_path = f"movie/{self.params_hash}.mp4"
        self.apply_limit()

    def params_to_hash(self):
        text = f"{self.url}{self.width}{self.height}{self.max_height}{self.scroll_px}{str(self.targets)}".encode()
        return hashlib.sha3_256(text).hexdigest()

    def apply_limit(self):
        limit_minimum_scroll = 200
        limit_max_height = 100000
        limit_width = 1920
        limit_height = 1920
        if self.width > limit_width: self.width = limit_width
        if self.height > limit_height: self.height = limit_height
        if self.max_height > limit_max_height: self.max_height = limit_max_height
        if self.scroll_px < limit_minimum_scroll: self.scroll_px = limit_minimum_scroll
