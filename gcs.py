import google.cloud.storage


class FileManager:
    """Uploads a file to the bucket.
    This class has 3 methods:
    1. upload_file: Uploads a file to the bucket. return None
    2. delete_file: Deletes a file from the bucket. return bool
    3. download_file: Downloads a file from the bucket. return url
    """

    def __init__(self, bucket_name: str):
        self.bucket_name = bucket_name
        self.storage_client = google.cloud.storage.Client()
        self.bucket = self.storage_client.get_bucket(bucket_name)

    def upload_file(self, file_path: str, file_name: str) -> None:
        """Uploads a file to the bucket."""
        blob = self.bucket.blob(file_name)
        blob.upload_from_filename(file_path)

    def delete_file(self, file_name: str) -> bool:
        """Deletes a file from the bucket."""
        blob = self.bucket.blob(file_name)
        return blob.delete()

    def download_file(self, file_name: str) -> str:
        """Downloads a file from the bucket."""
        blob = self.bucket.blob(file_name)
        return blob.generate_signed_url(expiration=300, version="v4")
