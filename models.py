from pydantic import BaseModel


class BrowserSetting(BaseModel):
    url: str
    width: int = 1280
    height: int = 720
    lang: str = 'en-US'
    catch: bool = True
    page_height: int = 50000
    wait_time: int = 1


class GithubSetting(BaseModel):
    url: str
    targets: str
    width: int = 1280
    height: int = 720
    lang: str = 'en-US'
    cache: bool = True
    page_height: int = 50000
