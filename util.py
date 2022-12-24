import glob
import subprocess
import time
from pathlib import Path
import cv2
import pdf2image
import logging

logger = logging.getLogger(__name__)


def image2mp4(image_dir: str, movie_path: str, fps: int = 1):
    fps = 1 / fps
    image_files = sorted(glob.glob(f"{image_dir}/*.png"))

    height, width, _ = cv2.imread(image_files[0]).shape[:3]
    video_writer = cv2.VideoWriter(
        str(movie_path),
        cv2.VideoWriter_fourcc('m', 'p', '4', 'v'),
        fps, (width, height))

    for image_file in image_files:
        img = cv2.imread(image_file)
        video_writer.write(img)
    video_writer.release()


def pdf_to_image(pdf_bytes: bytes, image_dir: Path) -> None:
    """
    Convert pdf to image.
    :param pdf_bytes: pdf file bytes.
    :param image_dir: image directory path.
    :return: None
    """
    images = [image_path for image_path in pdf2image.convert_from_bytes(pdf_bytes)]
    for i, image in enumerate(images):
        image.save(image_dir / f"{str(i).zfill(3)}.png")


def to_m3u8(input_path: Path, output_path: Path, base_url: str, buffer_sec=5):
    """
    Caution! This works only Desktop Sharing.
    Convert mp4 file to m3u8 file.
    :param input_path: mp4 file path
    :param output_path: m3u8 file path
    :param base_url: base url
    :param buffer_sec: buffer seconds
    :return:
    """
    if output_path.exists():
        return
    time.sleep(buffer_sec)
    # Convert to m3u8 file.
    command = f'ffmpeg -re -i {input_path} ' \
              f'-c:v copy ' \
              f'-r 24 ' \
              f'-c:a aac -b:a 128k -strict -2 ' \
              f'-f hls ' \
              f'-hls_playlist_type event ' \
              f'-hls_time 2 ' \
              f'-hls_list_size 10 ' \
              f"-hls_flags delete_segments " \
              f'-hls_segment_filename "{output_path.parent}/video%3d.ts" ' \
              f'-hls_base_url {base_url} ' \
              f'-timeout 0.1 ' \
              f'-flags +global_header ' \
              f'{output_path}'
    logger.info(f"ffmpeg command: {command}")
    subprocess.run(command, shell=True, check=True)
    logger.info(f'ffmpeg command: {command} is finished.')
