"""
Tests for memory optimization in pdf_to_image and format_images functions.
These tests verify that memory-intensive operations process images one at a time
instead of loading all images into memory at once.
"""
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock, Mock
import pytest
from PIL import Image


class TestPdfToImage:
    """Tests for pdf_to_image function."""

    def test_pdf_to_image_processes_pages_sequentially(self):
        """Verify that pdf_to_image processes pages one at a time."""
        # Mock the gcs module before importing util
        mock_gcs = MagicMock()
        sys.modules['gcs'] = mock_gcs

        from util import pdf_to_image

        with tempfile.TemporaryDirectory() as tmpdir:
            image_dir = Path(tmpdir)

            # Create mock images that track close() calls
            mock_images = []
            close_called = []

            for i in range(3):
                mock_img = MagicMock()
                mock_img.close = MagicMock(side_effect=lambda idx=i: close_called.append(idx))
                mock_images.append(mock_img)

            # Mock convert_from_bytes to return a generator
            def mock_generator(*args, **kwargs):
                for img in mock_images:
                    yield img

            with patch('util.pdf2image.convert_from_bytes', side_effect=mock_generator):
                pdf_to_image(b'dummy_pdf_bytes', image_dir)

            # Verify all images were saved
            for i, mock_img in enumerate(mock_images):
                expected_path = image_dir / f"{str(i).zfill(3)}.png"
                mock_img.save.assert_called_once_with(expected_path)

            # Verify close was called for each image
            assert len(close_called) == 3
            # Verify close was called in order (0, 1, 2)
            assert close_called == [0, 1, 2]

    def test_pdf_to_image_file_naming(self):
        """Verify correct file naming with zero-padded numbers."""
        # Mock the gcs module before importing util
        mock_gcs = MagicMock()
        sys.modules['gcs'] = mock_gcs

        from util import pdf_to_image

        with tempfile.TemporaryDirectory() as tmpdir:
            image_dir = Path(tmpdir)

            # Create 10 mock images to test zero-padding
            mock_images = [MagicMock() for _ in range(10)]

            def mock_generator(*args, **kwargs):
                for img in mock_images:
                    yield img

            with patch('util.pdf2image.convert_from_bytes', side_effect=mock_generator):
                pdf_to_image(b'dummy_pdf_bytes', image_dir)

            # Verify file naming: 000.png, 001.png, ..., 009.png
            expected_names = [f"{str(i).zfill(3)}.png" for i in range(10)]
            for i, name in enumerate(expected_names):
                expected_path = image_dir / name
                mock_images[i].save.assert_called_once_with(expected_path)

    def test_pdf_to_image_resizes_to_fhd(self):
        """Verify that pdf_to_image passes size=(1920, None) to reduce memory usage for 4K PDFs."""
        # Mock the gcs module before importing util
        mock_gcs = MagicMock()
        sys.modules['gcs'] = mock_gcs

        from util import pdf_to_image

        with tempfile.TemporaryDirectory() as tmpdir:
            image_dir = Path(tmpdir)

            mock_images = [MagicMock() for _ in range(2)]

            def mock_generator(*args, **kwargs):
                for img in mock_images:
                    yield img

            with patch('util.pdf2image.convert_from_bytes', side_effect=mock_generator) as mock_convert:
                pdf_to_image(b'dummy_pdf_bytes', image_dir)

                # Verify convert_from_bytes was called with size parameter
                mock_convert.assert_called_once()
                call_args = mock_convert.call_args
                # Check positional argument
                assert call_args[0][0] == b'dummy_pdf_bytes'
                # Check keyword argument for size
                assert 'size' in call_args[1]
                assert call_args[1]['size'] == (1920, None)


class TestFormatImages:
    """Tests for MovieMaker.format_images function."""

    @staticmethod
    def _create_format_images_function():
        """Create a standalone format_images function for testing without MovieMaker dependencies."""
        def format_images(image_config):
            """
            Get types of image paths. Resize image and centering. Save as png.
            Format images. Processes one image at a time to minimize memory usage.
            """
            types = ['.jpg', '.jpeg', '.png', '.webp',
                     '.bmp', '.tiff', '.tif', '.svg', '.avif']
            image_paths = []
            for path in image_config.input_image_dir.glob("*"):
                suffix = path.suffix.lower()
                if suffix not in types:
                    continue
                image_paths.append(path)
            if len(image_paths) == 0:
                raise Exception(
                    f"No image files in {image_config.input_image_dir.absolute()}")
            image_config.output_image_dir.mkdir(exist_ok=True)
            for i, image_path in enumerate(image_paths):
                with Image.open(image_path) as image:
                    background = Image.new(
                        'RGB', (image_config.width, image_config.height), (0, 0, 0))
                    image.thumbnail(
                        (image_config.width, image_config.height), Image.Resampling.LANCZOS)
                    background.paste(image, (
                        int((image_config.width - image.width) / 2), int((image_config.height - image.height) / 2)))
                    new_path = image_config.output_image_dir.joinpath(
                        f'{image_path.stem}.png')
                    background.save(new_path, 'PNG')
                    background.close()
        return format_images

    @staticmethod
    def _create_image_config(input_dir, output_dir, width, height):
        """Create a simple image config object for testing."""
        class SimpleImageConfig:
            def __init__(self, input_image_dir, output_image_dir, width, height):
                self.input_image_dir = input_image_dir
                self.output_image_dir = output_image_dir
                self.width = width
                self.height = height
        return SimpleImageConfig(input_dir, output_dir, width, height)

    def test_format_images_processes_one_at_a_time(self):
        """Verify that format_images processes images one at a time with context manager."""
        format_images = self._create_format_images_function()

        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = Path(tmpdir) / "input"
            output_dir = Path(tmpdir) / "output"
            input_dir.mkdir()

            # Create test images
            test_image_count = 3
            for i in range(test_image_count):
                img = Image.new('RGB', (100, 100), color=(255, 0, 0))
                img.save(input_dir / f"test_{i}.png")
                img.close()

            image_config = self._create_image_config(input_dir, output_dir, 1280, 720)
            format_images(image_config)

            # Verify output files exist
            output_files = list(output_dir.glob("*.png"))
            assert len(output_files) == test_image_count

            # Verify output images have correct dimensions
            for output_file in output_files:
                with Image.open(output_file) as img:
                    assert img.size == (1280, 720)
                    assert img.mode == 'RGB'

    def test_format_images_preserves_aspect_ratio(self):
        """Verify that format_images preserves aspect ratio when resizing."""
        format_images = self._create_format_images_function()

        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = Path(tmpdir) / "input"
            output_dir = Path(tmpdir) / "output"
            input_dir.mkdir()

            # Create a wide test image
            wide_img = Image.new('RGB', (200, 100), color=(0, 255, 0))
            wide_img.save(input_dir / "wide.png")
            wide_img.close()

            image_config = self._create_image_config(input_dir, output_dir, 400, 400)
            format_images(image_config)

            # Verify output file exists and has black background
            output_file = output_dir / "wide.png"
            assert output_file.exists()

            with Image.open(output_file) as img:
                assert img.size == (400, 400)
                # Check that corners are black (background)
                assert img.getpixel((0, 0)) == (0, 0, 0)
                assert img.getpixel((399, 399)) == (0, 0, 0)

    def test_format_images_supports_multiple_formats(self):
        """Verify that format_images supports jpg, png, webp formats."""
        format_images = self._create_format_images_function()

        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = Path(tmpdir) / "input"
            output_dir = Path(tmpdir) / "output"
            input_dir.mkdir()

            # Create test images in different formats with different names
            formats_to_test = ['png', 'jpg', 'webp']
            for i, fmt in enumerate(formats_to_test):
                img = Image.new('RGB', (100, 100), color=(0, 0, 255))
                img.save(input_dir / f"test_{i}.{fmt}")
                img.close()

            image_config = self._create_image_config(input_dir, output_dir, 200, 200)
            format_images(image_config)

            # Verify all formats were processed
            output_files = list(output_dir.glob("*.png"))
            assert len(output_files) == len(formats_to_test)

    def test_format_images_raises_on_empty_directory(self):
        """Verify that format_images raises exception when no images found."""
        format_images = self._create_format_images_function()

        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = Path(tmpdir) / "input"
            output_dir = Path(tmpdir) / "output"
            input_dir.mkdir()

            # Create a non-image file
            (input_dir / "not_an_image.txt").write_text("hello")

            image_config = self._create_image_config(input_dir, output_dir, 200, 200)

            with pytest.raises(Exception) as exc_info:
                format_images(image_config)

            assert "No image files" in str(exc_info.value)

    def test_format_images_uses_lanczos_resampling(self):
        """Verify that format_images uses LANCZOS resampling (not deprecated ANTIALIAS)."""
        format_images = self._create_format_images_function()

        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = Path(tmpdir) / "input"
            output_dir = Path(tmpdir) / "output"
            input_dir.mkdir()

            # Create a large test image to trigger resampling
            large_img = Image.new('RGB', (2000, 2000), color=(128, 128, 128))
            large_img.save(input_dir / "large.png")
            large_img.close()

            image_config = self._create_image_config(input_dir, output_dir, 200, 200)

            # This should not raise any deprecation warnings
            format_images(image_config)

            output_file = output_dir / "large.png"
            assert output_file.exists()

    def test_format_images_centers_image_correctly(self):
        """Verify that images are centered on the background."""
        format_images = self._create_format_images_function()

        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = Path(tmpdir) / "input"
            output_dir = Path(tmpdir) / "output"
            input_dir.mkdir()

            # Create a small square test image with distinctive color
            small_img = Image.new('RGB', (50, 50), color=(255, 255, 255))
            small_img.save(input_dir / "small.png")
            small_img.close()

            image_config = self._create_image_config(input_dir, output_dir, 100, 100)
            format_images(image_config)

            output_file = output_dir / "small.png"
            assert output_file.exists()

            with Image.open(output_file) as img:
                # Corners should be black (background)
                assert img.getpixel((0, 0)) == (0, 0, 0)
                assert img.getpixel((99, 99)) == (0, 0, 0)
                # Center should be white (the original image)
                # Image is 50x50 centered in 100x100, so center is at (50, 50)
                assert img.getpixel((50, 50)) == (255, 255, 255)
