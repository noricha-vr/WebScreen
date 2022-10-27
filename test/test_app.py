import os

import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

"""
This test needs GOOGLE_APPLICATION_CREDENTIALS
"""
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/app/credentials.json"


def test_index():
    response = client.get("/")
    assert response.status_code == 200
    assert "ScreenCapture" in response.text


@pytest.mark.parametrize(('url',), [
    ('https://www.google.com/',),
])
def test_create_movie(url):
    response = client.get(f"/api/create_movie/?url={url}")
    # Why redirect response is in history?
    response = response.history[0]
    assert response.status_code == 303
    assert "https://storage.googleapis.com/" in response.headers.get('location')


@pytest.mark.parametrize(('url', 'images'), [
    ('https://www.google.com/', ['test_image/01.png', 'test_image/02.png', 'test_image/03.png']),
])
def test_create_image_movie(url, images):
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
    url = f"/api/create_github_movie/?url={url}&targets={targets}"
    print(url)
    response = client.get(url)
    # show error message if the movie is not created.
    print(response.text)
    response = response.history[0]
    assert response.status_code == 303
    assert "https://storage.googleapis.com/" in response.headers.get('location')
