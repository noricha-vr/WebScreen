import os
from pprint import pprint

from fastapi.testclient import TestClient
from main import app
import pytest

client = TestClient(app)

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/app/credentials.json"


def test_index():
    response = client.get("/")
    assert response.status_code == 200
    assert "NorichaConverter" in response.text


def test_create_movie():
    """This test needs GOOGLE_APPLICATION_CREDENTIALS"""
    response = client.get("/create_movie/?url=https://www.google.com")
    # Why redirect response is in history?
    response = response.history[0]
    assert response.status_code == 303
    assert "https://storage.googleapis.com/" in response.headers.get('location')
