import google.cloud.storage


class BucketManager:
    """Uploads a file to the bucket.
    This class has 4 methods:
    1. upload_file: Uploads a file to the bucket. return None
    2. public_file_url: Get a file public url from the bucket. return str
    3. make_public: Make a file public. return bool
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

    def get_public_file_url(self, file_name: str) -> str:
        """
        Get a file public url from the bucket.
        :param file_name:
        :return str:
        """
        blob = self.bucket.get_blob(file_name)
        return blob.public_url

    def make_public(self, file_name: str) -> bool:
        """
        Make a file public.
        :param file_name:
        :return bool:
        """
        blob = self.bucket.get_blob(file_name)
        return blob.make_public()
