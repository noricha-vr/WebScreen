import hashlib
from typing import List


class MovieConfig:

    def __init__(self, url, width, height, max_height, scroll_px, targets: List[str] = None):
        self.url = url
        self.domain = url.split("/")[2]
        self.width = width
        self.height = height
        self.max_height = max_height
        self.scroll_px = scroll_px
        self.targets = targets
        self.params_hash = self.params_to_hash()
        self.movie_path = f"movie/{self.params_hash}.mp4"

    def params_to_hash(self):
        text = f"{self.url}{self.width}{self.height}{self.max_height}{self.scroll_px}{str(self.targets)}".encode()
        return hashlib.sha3_256(text).hexdigest()
