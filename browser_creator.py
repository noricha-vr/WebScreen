from browsers.base_browser import BaseBrowser
from browsers.general_browser import GeneralBrowser
from browsers.twitter_browser import TwitterBrowser


# Which is better set params to constructor or create_browser?
class BrowserCreator:
    def __init__(self, domain, width, height, max_height, scroll_px):
        self.domain = domain
        self.width = width
        self.height = height
        self.max_height = max_height
        self.scroll_px = scroll_px

    def create_browser(self) -> BaseBrowser:
        """Select customized browser for each domain.
        :return: browser: customized browser
        """
        if self.domain == "twitter.com": return TwitterBrowser(self.width, self.height, self.max_height, self.scroll_px)
        if self.domain == "github.com": return GithubBrowser(self.width, self.height, self.max_height, self.scroll_px)
        return GeneralBrowser(self.width, self.height, self.max_height, self.scroll_px)
