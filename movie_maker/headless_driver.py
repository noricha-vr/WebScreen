import os
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from movie_maker import BrowserConfig


def create_headless_chromedriver(browser_config: BrowserConfig) -> webdriver:
    """
    Create headless Chrome driver.
    :param browser_config: BrowserConfig object
    :return: Chrome driver
    """
    # Set locale
    os.environ['LANG'] = f'{browser_config.locale}.UTF-8'
    os.environ['LC_ALL'] = f'{browser_config.locale}.UTF-8'
    # The following options are required to make headless Brave
    # Works in a Docker container
    chrome_options = webdriver.ChromeOptions()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument(f"--lang={browser_config.lang}")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument(f"window-size={browser_config.width},{browser_config.height}")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--remote-debugging-port=9222")
    chrome_options.add_argument(
        "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36")
    service = Service()   # your path to chromedriver executable file
    driver = webdriver.Chrome(service=service, options=chrome_options)
    driver.set_page_load_timeout(browser_config.page_load_timeout)
    return driver
