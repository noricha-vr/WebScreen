from movie_maker.browser import BaseBrowser
import time


# TODO remove this class
class TwitterBrowser(BaseBrowser):

    def wait(self) -> None:
        """
        Wait for the javascript rendering.
        :return: None
        """
        pass
