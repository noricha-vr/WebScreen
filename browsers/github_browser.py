import time
from pathlib import Path
from typing import List
from selenium.webdriver.common.by import By
from browsers.base_browser import BaseBrowser
from browsers.general_browser import GeneralBrowser


class GithubBrowser(GeneralBrowser):
    """
    GitHub browser crawl selected type files.
    """

    def read_target_urls(self, file_types: List[str]) -> List[str]:
        """
        Crawl all folder and collect selected type files urls.
        1. Read folder urls.
        2. Read file urls.
        3. Open folder urls.
        4. Repeat 1-3.
        Select file type.
        :param file_types: selected file types.
        :return: List of file urls.
        """
        folder_urls = self.__read_folder_urls()
        target_urls = self.__read_target_file_urls(file_types)
        self.take_screenshot()
        # Open and read subdirectory.
        for i in range(0, len(folder_urls)):
            url = folder_urls[i]
            print(f"Open folder: {url}")
            self.driver.get(url)
            time.sleep(1)
            self.take_screenshot()
            folder_urls.extend(self.__read_folder_urls())
            target_urls.extend(self.__read_target_file_urls(file_types))
        return target_urls

    def __read_folder_urls(self) -> List[str]:
        """
        Read all folder urls.
        :return: List of folder urls.
        """
        folder_urls = []
        read_folder_urls_xpath = "//*[@aria-label='Directory']/../..//a[@class='js-navigation-open Link--primary']"
        for folder_element in self.driver.find_elements(By.XPATH, read_folder_urls_xpath):
            folder_urls.append(folder_element.get_attribute("href"))
        return folder_urls

    def __read_target_file_urls(self, file_types: List[str]) -> List[str]:
        """
        Collect selected type files urls.
        :param file_types: select target file types.
        :return: List of file urls.
        """
        file_urls = []
        for file_type in file_types:
            file_elements = self.driver.find_elements(By.XPATH, f"//a[contains(@href, '{file_type}')]")
            for file_element in file_elements:
                file_urls.append(file_element.get_attribute("href"))
        return file_urls

    def download_zip_file(self) -> Path:
        """
        Download zip file.
        :return: Path of zip file.
        """
        # click Code button.
        code_button_xpath = '//*[@data-action="toggle:get-repo#onDetailsToggle"]'
        self.driver.find_element(By.XPATH, code_button_xpath).click()
        # click Download ZIP button.
        download_zip_file_xpath = "//*[@aria-label='Download ZIP']"
        self.driver.find_element(By.XPATH, download_zip_file_xpath).click()
        time.sleep(5)
        return self.__get_zip_file_path()

    def __get_zip_file_path(self) -> Path:
        """
        Get zip file path.
        :return: Path of zip file.
        """
        zip_file_path = Path(self.folder_path).parent / "master.zip"
        return zip_file_path
