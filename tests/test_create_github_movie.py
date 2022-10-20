from pathlib import Path


class TestCreateGithubMovie:

    def test_create_movie(self, browser, bucket_manager):
        browser.driver.get("https://github.com")
        browser.scroll_to_bottom()
        movie_path = browser.create_movie()
        public_url = bucket_manager.to_public_url(movie_path)
        assert public_url is not None
        assert Path(movie_path).exists()
