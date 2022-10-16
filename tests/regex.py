import re


class Regex:
    @staticmethod
    def git_url_to_download_url(url: str) -> str:
        """
        Convert git url to download url
        :param url:
        :return: download url
        """
        return re.sub(r'github.com', 'codeload.github.com', url) + '/zip/master'
