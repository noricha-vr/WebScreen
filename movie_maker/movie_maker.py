import shutil
import subprocess
import time
from pathlib import Path
from threading import Thread
from typing import List
from PIL import Image

from source_converter import SourceConverter, GithubDownloader
from movie_maker.browser import BrowserCreator
from movie_maker import BrowserConfig, ImageConfig
from movie_maker.config import MovieConfig
from dataclasses import dataclass
import logging

logger = logging.getLogger(__name__)


class MovieMaker:
    """
    This class is used to make movie from website.
    If input GitHub repository URL, download and converted to HTML. Then take screenshots and make movie.
    """

    @staticmethod
    def __copy_for_frame_rate_images(image_paths: List[Path], frame_rate) -> None:
        """
        Copy files to create images for frame rate.
        :param image_paths:
        :param frame_rate:
        :return:
        """
        # copy images framerate times -1
        t = []
        for i in range(1, frame_rate):
            for image_path in image_paths:
                # copy image. file name is {image.stem}_{i}.{image.suffix}
                t.append(Thread(target=shutil.copy,
                                args=(
                                    image_path,
                                    image_path.parent.joinpath(f'{image_path.stem}_{i}{image_path.suffix}'))))
        [thread.start() for thread in t]
        [thread.join() for thread in t]

    @staticmethod
    def to_vrc_movie(movie_config) -> None:
        """
        Create image_dir files to movie.
        If audio is False, remove audio from movie.
        :param movie_config:
        :return None:
        """
        audio_setting = ['-c:a', 'aac', '-strict', '-2'] if movie_config.has_audio else ['-an']
        command = [
                      'ffmpeg',
                      '-i', f'{movie_config.input_image_dir}',
                      '-c:v', 'copy',  # copy codec(video)
                  ] + audio_setting + [
                      '-pix_fmt', 'yuv420p',  # pixel format (color space)
                      '-y',  # overwrite output file
                      f'{movie_config.output_movie_path}'
                  ]
        logger.info(f'command: {command}')
        subprocess.call(command)

    @staticmethod
    def image_to_movie(movie_config: MovieConfig) -> None:
        """
        Create image_dir files to movie.
        :param movie_config:
        :return None:
        """
        image_paths = sorted(movie_config.input_image_dir.glob(f'*.{movie_config.image_type}'))
        if len(image_paths) == 0:
            raise Exception(
                f"No image files in {movie_config.input_image_dir.absolute()}. "
                f"Target file type is {movie_config.image_type}"
                f"Image dir files are {list(movie_config.input_image_dir.glob('*'))}")
        MovieMaker.__copy_for_frame_rate_images(image_paths, movie_config.frame_rate)
        # stop watch
        start = time.time()
        commands = ['ffmpeg',
                            '-framerate', f'{movie_config.frame_rate}',
                            '-pattern_type', 'glob', '-i', f'{movie_config.input_image_dir}/*.{movie_config.image_type}',
                            '-vf', f"scale='min({movie_config.width},iw)':-2",
                            '-c:v', 'h264',
                            '-pix_fmt', 'yuv420p',
                            '-preset', movie_config.encode_speed,
                            '-profile:v', 'baseline',  # 追加した部分
                            '-tune', 'stillimage',
                            '-y',
                            f'{movie_config.output_movie_path}']

        logger.info(f'command: {commands}')
        subprocess.call(commands)
        logger.info(f"MovieMaker.image_to_movie: {time.time() - start} sec")

    @staticmethod
    def take_screenshots(browser_config: BrowserConfig) -> Path:
        """
        Take screenshots from the given URL.
        :return:
        """
        browser = None
        try:
            browser = BrowserCreator(browser_config).create_browser()
            browser.open(browser_config.url)
            time.sleep(browser_config.wait_time)
            image_paths = browser.take_screenshots()
        except Exception as e:
            raise e
        finally:
            browser.driver.quit()
        return image_paths

    @staticmethod
    def take_local_file_screenshots(file_paths: List[Path], browser_config: BrowserConfig) -> Path:
        """
        Take screenshots from the given local files.
        :param file_paths:
        :param browser_config:
        :return: image_dir
        """
        image_dir = None
        browser = None
        try:
            # Take multi files screenshots.
            browser = BrowserCreator(browser_config).create_browser()
            for html_path in file_paths[:browser_config.max_file_count]:
                browser.open(f"file://{html_path.absolute()}")
                image_dir = browser.take_screenshots()
        except Exception as e:
            raise e
        finally:
            browser.driver.quit()
        return image_dir

    @staticmethod
    def take_screenshots_github_files(browser_config: BrowserConfig) -> Path:
        """
        Create a movie from the given GitHub url.
        :param browser_config:
        :return: movie_path
        """
        # download source code
        words = browser_config.url.split("/")
        if len(words) < 5:
            raise Exception(f"Invalid GitHub URL: {browser_config.url}")
        project_name = words[4]
        folder_path = GithubDownloader.download_github_archive_and_unzip_to_file(browser_config.url, project_name)
        project_path = GithubDownloader.rename_project(folder_path, project_name)
        # Convert the source codes to html files.
        source_converter = SourceConverter('default')
        html_file_path = source_converter.project_to_html(project_path, browser_config.targets)
        image_dir = MovieMaker.take_local_file_screenshots(html_file_path, browser_config)
        return image_dir

    @staticmethod
    def format_images(image_config: ImageConfig) -> None:
        """
        Get types of image paths. Resize image and centering. Save as png.
        Format images.
        :param image_config:
        """
        types = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif', '.svg', '.avif']
        image_paths = []
        # Get image paths.
        for path in image_config.input_image_dir.glob("*"):
            suffix = path.suffix.lower()
            if suffix not in types: continue
            image_paths.append(path)
        if len(image_paths) == 0:
            raise Exception(f"No image files in {image_config.input_image_dir.absolute()}")
        image_config.output_image_dir.mkdir(exist_ok=True)
        images = [Image.open(image_path) for image_path in image_paths]
        for i, image in enumerate(images):
            background = Image.new('RGB', (image_config.width, image_config.height), (0, 0, 0))
            # resize image. keep aspect ratio
            image.thumbnail((image_config.width, image_config.height), Image.ANTIALIAS)
            # centering
            background.paste(image, (
                int((image_config.width - image.width) / 2), int((image_config.height - image.height) / 2)))
            new_path = image_config.output_image_dir.joinpath(f'{image_paths[i].stem}.png')
            background.save(new_path, 'PNG')
