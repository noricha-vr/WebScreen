import google.cloud.storage


class BucketManager:
    """Uploads a file to the bucket.
    This class has 3 methods:
    1. upload_file: Uploads a file to the bucket. return None
    2. delete_file: Deletes a file from the bucket. return bool
    3. get_file_url: Get a file credential url from the bucket. return str
    """

    def __init__(self, bucket_name: str):
        self.bucket_name = bucket_name
        self.storage_client = google.cloud.storage.Client()
        self.bucket = self.storage_client.get_bucket(self.bucket_name)

    def upload_file(self, file_path: str, file_name: str) -> None:
        """
        Uploads a file to the bucket.
        :param file_path:
        :param file_name:
        :return None:
        """
        blob = self.bucket.blob(file_name)
        blob.upload_from_filename(file_path)

    def delete_file(self, file_name: str) -> bool:
        """
        Deletes a file from the bucket.
        :param file_name:
        :return bool:
        """
        blob = self.bucket.blob(file_name)
        return blob.delete()

    def get_file_url(self, file_name: str) -> str:
        """
        Get a file credential url from the bucket.
        :param file_name:
        :return str:
        """
        blob = self.bucket.get_blob(file_name)
        return blob.generate_signed_url(expiration=3600)
