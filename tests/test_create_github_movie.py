from browser_creator import BrowserCreator
from browsers.github_browser import GithubBrowser
from hash_maker import params_to_hash
from movie_maker import image_to_movie
import pytest
from moviepy import editor
from tests.test_create_movie import reset_image_and_movie_folder


@pytest.mark.parametrize(('url', 'file_types', 'length'), [
    ("https://github.com/noricha-vr/screen_capture", ['.py'], 5),  # Limit test
])
def test_create_movie(url, file_types, length):
    reset_image_and_movie_folder()
    # Create movie.
    width, height, max_height, scroll_height = 1280, 720, 5000, 200
    params_hash = params_to_hash(url, width, height, max_height, scroll_height)
    movie_path = f"movie/{params_hash}.mp4"
    browser = GithubBrowser(width, height, max_height, scroll_height)
    browser.open(url)
    urls = browser.read_target_urls(file_types)
    print(f'urls: {urls}')
    paths = browser.take_screenshots(urls)
    image_to_movie(paths, movie_path)
    # Check movie.
    movie = editor.VideoFileClip(movie_path)
    assert length == movie.duration
