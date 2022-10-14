from selenium import webdriver
from webdriver_manager.chrome import ChromeDriverManager


def create_headless_chromedriver(width: int = 1026, height: int = 768):
    # The following options are required to make headless Chrome
    # Work in a Docker container
    chrome_options = webdriver.ChromeOptions()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument(f"window-size={width},{height}")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--remote-debugging-port=9222")
    # Initialize a new browser
    return webdriver.Chrome(ChromeDriverManager().install(), chrome_options=chrome_options)
