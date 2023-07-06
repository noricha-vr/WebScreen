from movie_maker.browser.base_browser import BaseBrowser
from movie_maker.browser.general_browser import GeneralBrowser
from movie_maker.browser.twitter_browser import TwitterBrowser
from movie_maker import BrowserConfig


# TODO remove this class
class BrowserCreator:
    def __init__(self, movie_config: BrowserConfig):
        self.browser_config = movie_config

    def create_browser(self) -> BaseBrowser:
        """Select customized browser for each domain.
        :return: browser: customized browser
        """
        # if self.browser_config.domain == "twitter.com": return TwitterBrowser(self.browser_config)
        return GeneralBrowser(self.browser_config)
