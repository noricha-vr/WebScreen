import time
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
        # Open and read subdirectory.
        for i in range(0, len(folder_urls)):
            print(f"Open folder: {folder_urls[i]}")
            self.driver.get(folder_urls[i])
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
