"""
Tests for the /api/save-movie/ endpoint and COOP/COEP headers.
These tests verify that the API accepts UploadFile format for WASM PDF conversion support.
"""
import io
import os
import pytest

# Set environment variables before importing the app
os.environ.setdefault('BUCKET_NAME', 'test-bucket')
os.environ.setdefault('GOOGLE_APPLICATION_CREDENTIALS', '/app/credentials.json')


class TestCOOPCOEPHeaders:
    """Tests for COOP/COEP headers required for SharedArrayBuffer."""

    @pytest.fixture
    def client(self):
        """Create test client with the wrapped ASGI app."""
        from starlette.testclient import TestClient
        from router.main import app
        return TestClient(app)

    def test_coop_header_on_root(self, client):
        """Test that Cross-Origin-Opener-Policy header is set on root."""
        response = client.get('/', follow_redirects=False)
        assert 'cross-origin-opener-policy' in response.headers
        assert response.headers['cross-origin-opener-policy'] == 'same-origin'

    def test_coep_header_on_root(self, client):
        """Test that Cross-Origin-Embedder-Policy header is set on root."""
        response = client.get('/', follow_redirects=False)
        assert 'cross-origin-embedder-policy' in response.headers
        assert response.headers['cross-origin-embedder-policy'] == 'require-corp'

    def test_headers_on_api_endpoints(self, client):
        """Test that headers are present on API endpoints."""
        response = client.get('/api/')
        assert 'cross-origin-opener-policy' in response.headers
        assert 'cross-origin-embedder-policy' in response.headers
        assert response.headers['cross-origin-opener-policy'] == 'same-origin'
        assert response.headers['cross-origin-embedder-policy'] == 'require-corp'

    def test_headers_on_static_files(self, client):
        """Test that headers are present on static file routes."""
        response = client.get('/favicon.ico')
        assert 'cross-origin-opener-policy' in response.headers
        assert 'cross-origin-embedder-policy' in response.headers

    def test_headers_on_pdf_page(self, client):
        """Test that headers are present on PDF page."""
        response = client.get('/en_US/pdf/')
        assert 'cross-origin-opener-policy' in response.headers
        assert 'cross-origin-embedder-policy' in response.headers


class TestSaveMovieAPIStructure:
    """Tests for /api/save-movie/ endpoint request structure."""

    def test_api_accepts_file_parameter(self):
        """Test that /api/save-movie/ endpoint signature accepts 'file' parameter."""
        from router.api import recode_desktop
        import inspect

        # Get function signature
        sig = inspect.signature(recode_desktop)
        params = list(sig.parameters.keys())

        # Verify 'file' parameter exists
        assert 'file' in params, "API should accept 'file' parameter"

    def test_api_returns_dict(self):
        """Test that return type annotation is dict."""
        from router.api import recode_desktop
        import inspect

        sig = inspect.signature(recode_desktop)

        # Check return annotation
        assert sig.return_annotation == dict, "API should return dict"
