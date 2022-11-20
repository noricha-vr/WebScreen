import glob
import os
import shutil

import pytest
from fastapi.testclient import TestClient
from main import app

"""
This test needs GOOGLE_APPLICATION_CREDENTIALS
"""
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/app/credentials.json"
# Rest image and movie folder.
for folder in glob.glob("image/*"): shutil.rmtree(folder)
for file in glob.glob("movie/*.mp4"): os.remove(file)

client = TestClient(app)


def test_index():
    response = client.get("/")
    assert response.status_code == 200
    assert "Web Screen" in response.text


@pytest.mark.parametrize(('url', 'max_page_height', 'width', 'height', 'lang'), [
    # ('https://www.google.com/', 200, 1280, 720, 'en_US'),
    # ('https://www.youtube.com/', 1000, 1280, 720, 'ja_JP'),
    ('https://twitter.com/search?q=%23WebScreen&src=hashtag_click', 200000, 200000, 200000, 'ja_JP'),
    ('https://fastapi.tiangolo.com/async/#very-technical-details', 0, 0, 0, 'ja_JP'),
    (
            'https://www.google.co.jp/maps/place/HUB%E7%A7%8B%E8%91%89%E5%8E%9F%E5%BA%97/@35.700164,138.7193184,9z/data=!3m1!5s0x60188ea7985323af:0x1c68bb773edd834a!4m10!1m2!2m1!1z56eL44OP44OW!3m6!1s0x60188ea7bd68888d:0x25f90a2ae6b34060!8m2!3d35.700164!4d139.7740059!15sCgnnp4vjg4_jg5YiA4gBAVoMIgrnp4sg44OP44OWkgEDcHVimgEkQ2hkRFNVaE5NRzluUzBWSlEwRm5TVVE0YkZsbVFuZG5SUkFC4AEA!16s%2Fg%2F1tvw4y7l?hl=ja',
            1000, 1280, 720, 'ja_JP'),
    (
            'https://www.google.com/search?q=%E9%A3%9F%E3%83%86%E3%83%AD&tbm=isch&ved=2ahUKEwjy5Le2vqr7AhV1QfUHHY8XCvsQ2-cCegQIABAA&oq=%E9%A3%9F%E3%83%86%E3%83%AD&gs_lcp=CgNpbWcQAzIFCAAQgAQyBQgAEIAEMgUIABCABDIFCAAQgAQyBQgAEIAEMgUIABCABDoHCAAQBBCABDoECCMQJzoHCCMQ6gIQJzoKCAAQBBCABBCxAzoICAAQsQMQgwE6CAgAEIAEELEDOgYIABAEEAM6DQgAEAQQgAQQsQMQgwE6CQgAEAQQgAQQGDoLCAAQgAQQsQMQsQNQ2AFY3ShgmStoCXAAeAKAAYwBiAHJE5IBBDIyLjaYAQCgAQGqAQtnd3Mtd2l6LWltZ7ABCsABAQ&sclient=img&ei=BYlwY7LONfWC1e8Pj6-o2A8&bih=1014&biw=1245&rlz=1C5GCEM_enJP1012JP1012',
            1000, 1280, 720, 'ja_JP'),
])
def test_create_movie(url, max_page_height, width, height, lang):
    response = client.post(
        f"/api/create_movie/",
        json={"url": url, "max_page_height": max_page_height, "width": width,
              "height": height, "lang": lang,
              }, )
    assert response.status_code == 200
    assert response.json().get('url').startswith("https://storage.googleapis.com/")


@pytest.mark.parametrize(('images'), [
    (['test_image/01.png', 'test_image/02.png', 'test_image/03.png']),
])
# this test can't run. status code is 400.
def test_create_image_movie(images):
    files = {}
    for i, image in enumerate(images):
        files[f'file_{i}'] = [image, open(image, 'rb'), 'image/png']

    """
    /usr/local/lib/python3.8/site-packages/requests/models.py:191: ValueError
    Will successfully encode files when passed as a dict or a list of
        tuples. Order is retained if data is a list of tuples but arbitrary
        if parameters are supplied as a dict.
        """
    response = client.post(f"/api/create_image_movie/", files=files,
                           headers={"Content-Type": "multipart/form-data;boundary='boundary'"})
    assert response.status_code != 422
    # Why redirect response is in history?
    response = response.history[0]
    assert response.status_code == 303
    assert "https://storage.googleapis.com/" in response.headers.get('location')


@pytest.mark.parametrize(("url", 'targets'), [
    ("https://github.com/noricha-vr/source_converter", '*.md,*.py'),
])
def test_create_github_movie(url, targets):
    request_url = f"/api/create_github_movie/"
    response = client.post(request_url, headers={"Content-Type": "application/json"},
                           json={"url": url, "targets": targets, "width": 1280, "height": 720, "cache": 1})
    assert response.status_code == 200
    assert response.json().get('url').startswith("https://storage.googleapis.com/")
