from typing import List
from browsers.base_browser import BaseBrowser
import time


class TwitterBrowser(BaseBrowser):

    def take_screenshot(self) -> List[str]:
        """
        Take a screenshot of the given URL scrolling each px and returns image_file_paths.
        :return: image_file_paths:
        """
        time.sleep(6)
        self.set_scroll_height()
        file_paths = []
        # Take screenshots
        for px in range(0, self.movie_config.scroll_height, self.movie_config.scroll_each):
            self.driver.execute_script(f"window.scrollTo(0, {px})")
            file_path = f"{self.image_folder_path}/{px}.png"
            self.driver.save_screenshot(file_path)
            file_paths.append(file_path)
        self.driver.quit()
        return file_paths
