from typing import List


def create_movie(file_paths: List[str], movie_path: str) -> None:
    """
    Create a movie from the given file paths. Each file is 2 seconds.
    :param file_paths:
    :param movie_path:
    :return None:
    """
    # TODO remove first blank image
    from moviepy.editor import ImageSequenceClip
    clip = ImageSequenceClip(file_paths, fps=1)
    clip.write_videofile(movie_path, fps=1)
