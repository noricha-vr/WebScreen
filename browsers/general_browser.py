import time
from typing import List
from browsers.base_browser import BaseBrowser


class GeneralBrowser(BaseBrowser):

    def take_screenshot(self) -> List[str]:
        """
        Take a screenshot of the given URL scrolling each px and returns image_file_paths.
        :return: image_file_paths:
        """
        file_paths = []
        # Take screenshots
        for px in range(0, self.scroll_height, self.movie_config.scroll_each):
            self.driver.execute_script(f"window.scrollTo(0, {px})")
            file_path = f"{self.image_folder_path}/{self._get_page_no()}_{px}.png"
            self.driver.save_screenshot(file_path)
            file_paths.append(file_path)
        self.page_no += 1
        self.driver.quit()
        return file_paths

    def take_screenshots(self, urls: List[str]) -> List[str]:
        """
        Take a screenshot of the given URLs scrolling each px and returns image_file_paths.
        :return: image_file_paths:
        """
        file_paths = []
        for i, url in enumerate(urls):
            print(f"Take screenshot: {i + 1}/{len(urls)}: {url}")
            self.driver.get(url)
            time.sleep(5)
            file_paths.extend(self.take_screenshot())
        return file_paths
