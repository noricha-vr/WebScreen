import time
from typing import List
from movie_maker.browser import BaseBrowser


# TODO remove this class
class GeneralBrowser(BaseBrowser):

    def take_multi_page_screenshots(self, urls: List[str]) -> List[str]:
        """
        Take a screenshot of the given URLs scrolling each px and returns image_file_paths.
        :return: image_file_paths:
        """
        file_paths = []
        for i, url in enumerate(urls):
            print(f"Take screenshot: {i + 1}/{len(urls)}: {url}")
            self.driver.get(url)
            # time.sleep(5)
            file_paths.extend(self.take_screenshots())
        return file_paths
