import os

import pytest
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
    assert "NorichaConverter" in response.text


@pytest.mark.parametrize(('url',), [
    ('https://www.google.com/',),
])
def test_create_movie(url):
    response = client.get(f"/api/create_movie/?url={url}")
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
