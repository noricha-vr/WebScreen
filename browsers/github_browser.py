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
        for px in range(0, self.scroll_height, self.scroll_px):
            self.driver.execute_script(f"window.scrollTo(0, {px})")
            file_path = f"{self.folder_path}/{px}.png"
            self.driver.save_screenshot(file_path)
            file_paths.append(file_path)
        self.driver.quit()
        return file_paths
