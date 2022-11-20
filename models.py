from pydantic import BaseModel


class BrowserSetting(BaseModel):
    url: str
    width: int
    height: int
    lang: str = 'en-US'
    catch: bool = True
    page_height: int = 50000


class GithubSetting(BaseModel):
    url: str
    targets: str
    width: int
    height: int
    lang: str = 'en-US'
    cache: bool = True
    page_height: int = 50000
