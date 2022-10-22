import os
from typing import List

from starlette.responses import RedirectResponse

from browser_creator import BrowserCreator
from gcs import BucketManager
from hash_maker import params_to_hash

BUCKET_NAME = os.environ.get("BUCKET_NAME", None)


class MovieMaker:

    def __init__(self, bucket_name: str = None):
        self.bucket_manager = None
        if bucket_name is not None:
            self.bucket_manager = BucketManager(bucket_name)

    @staticmethod
    def image_to_movie(file_paths: List[str], movie_path: str) -> None:
        """
        Create a movie from the given file paths. Each file is 2 seconds.
        :param file_paths:
        :param movie_path:
        :return None:
        """
        from moviepy.editor import ImageSequenceClip
        clip = ImageSequenceClip(file_paths, fps=1)
        clip.write_videofile(movie_path, fps=1)
