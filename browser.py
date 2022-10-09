import time
from typing import List

from selenium import webdriver
from webdriver_manager.chrome import ChromeDriverManager


class HeadlessDriverGenerator:
    @staticmethod
    def get_headless_chromedriver(width: int = 1026, height: int = 768):
        # The following options are required to make headless Chrome
        # work in a Docker container
        chrome_options = webdriver.ChromeOptions()
        chrome_options.add_argument("--headless")
        chrome_options.add_argument("--disable-gpu")
        chrome_options.add_argument(f"window-size={width},{height}")
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")
        chrome_options.add_argument("--remote-debugging-port=9222")
        # Initialize a new browser
        return webdriver.Chrome(ChromeDriverManager().install(), chrome_options=chrome_options)


class Browser:
    def __init__(self, width: int = 1026, height: int = 768):
        self.driver = HeadlessDriverGenerator.get_headless_chromedriver(width, height)

    def take_screenshot(self, url: str, each_px: int = 300, max_height: int = 5000) -> List[str]:
        """
        Take a screenshot of the given URL and scroll each px then save it to a files.
        1. Open the URL
        2. Get the height of the page
        3. Scroll down each px
        4. Save the screenshot (file name is timestamp and scroll position)
        5. Repeat 2-4 until the height of the page
        :param url:
        :param each_px:
        :param max_height:
        :return: List of file absolute paths
        """
        self.driver.get(url)
        height = self.driver.execute_script("return document.body.scrollHeight")
        print(f"Height: {height} px URL: {url}")
        file_paths = []
        for px in range(0, height, each_px):
            self.driver.execute_script(f"window.scrollTo(0, {px})")
            file_path = f"image/{time.time()}-{px}.png"
            self.driver.save_screenshot(file_path)
            file_paths.append(file_path)
        return file_paths
