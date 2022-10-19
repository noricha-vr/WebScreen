from pathlib import Path

from source_converter.source_converter import SourceConverter


class TestSourceConverter:
    def test_file_to_html(self):
        source_converter = SourceConverter('default')
        html_file_path = source_converter.file_to_html(Path("project/source_converter/main.py"))
        assert html_file_path.exists() is True
        assert html_file_path == Path("html/source_converter/main.html")

    def test_select_target_files(self):
        project_folder_path = Path("project/source_converter")
        target_files = SourceConverter.select_target_files(project_folder_path, ['*.py'])
        assert len(target_files) == 5

    def test_project_to_html(self):
        source_converter = SourceConverter('default')
        html_paths = source_converter.project_to_html(Path("project/source_converter"), ['*.py'])
        assert len(html_paths) == 5
