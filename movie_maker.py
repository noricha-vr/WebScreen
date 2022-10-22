from pathlib import Path
from typing import List
from github_downloader import GithubDownloader
from source_converter import SourceConverter
from browser_creator import BrowserCreator
from movie_config import MovieConfig


class MovieMaker:

    def __init__(self, movie_config: MovieConfig, ):
        self.movie_config = movie_config

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

    def create_movie(self):
        """
        Create a movie from the given url.
        :return:
        """
        browser = BrowserCreator(self.movie_config).create_browser()
        browser.open(self.movie_config.url)
        try:
            image_paths = browser.take_screenshot()
            browser.driver.quit()
            # Create a movie
        except Exception as e:
            browser.driver.quit()
            print(e)
            raise e
        self.image_to_movie(image_paths, self.movie_config.movie_path)

    def create_github_movie(self) -> Path:
        """
        Create a movie from the given GitHub url.
        """
        # download source code
        project_name = self.movie_config.url.split("/")[4]
        folder_path = GithubDownloader.download_github_archive_and_unzip_to_file(self.movie_config.url, project_name)
        project_path = GithubDownloader.rename_project(folder_path, project_name)
        # Convert the source codes to html files.
        source_converter = SourceConverter('default')
        html_file_path = source_converter.project_to_html(project_path, self.movie_config.targets)
        # Take screenshots
        browser = BrowserCreator(self.movie_config).create_browser()
        image_paths = []
        for html_path in html_file_path:
            browser.open(f"file://{html_path.absolute()}")
            try:
                image_paths.extend(browser.take_screenshot())
            except Exception as e:
                browser.driver.quit()
                print(e)
                raise e
        browser.driver.quit()
        self.image_to_movie(image_paths, self.movie_config.movie_path)
        return self.movie_config.movie_path
