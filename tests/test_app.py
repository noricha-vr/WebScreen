import os

from fastapi.testclient import TestClient
from main import app
from unittest import TestCase

client = TestClient(app)

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/app/credentials.json"


class TestApp(TestCase):
    def test_index(self):
        response = client.get("/")
        assert response.status_code == 200
        assert "NorichaConverter" in response.text

    def test_create_movie(self):
        """This test needs GOOGLE_APPLICATION_CREDENTIALS"""
        response = client.get("/create_movie/?url=https://www.google.com")
        assert response.status_code == 200
        assert "https://storage.googleapis.com/" in response.text
