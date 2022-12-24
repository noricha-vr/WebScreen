import glob
import subprocess
import time
from pathlib import Path
import os
import pdf2image
import logging

import shutil

from gcs import BucketManager


def setup_logger(name, logfile='LOGFILENAME.txt'):
    _logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)

    # create console handler with a INFO log level
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch_formatter = logging.Formatter('%(levelname)s - %(asctime)s - %(message)s', '%Y-%m-%d %H:%M:%S')
    ch.setFormatter(ch_formatter)

    # add the handlers to the logger
    _logger.addHandler(ch)
    return _logger


logger = setup_logger(__name__)


def add_frames(image_dir: Path, frame_sec: int) -> None:
    """
    Add frames to the image directory. Image file format is png.
    :param image_dir: Image directory
    :param frame_sec: Frame rate
    :return: None
    """
    max_frame_sec = 2
    if frame_sec > max_frame_sec:
        frame_sec = max_frame_sec
    image_paths = sorted(image_dir.glob("*.png"))
    for image_path in image_paths:
        for i in range(frame_sec - 1):
            shutil.copy(image_path, image_path.parent / f"{image_path.stem}_{i}.png")


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


def to_m3u8(input_path: Path, output_path: Path, base_url: str, buffer_sec=5) -> None:
    """
    Caution! This works only Desktop Sharing.
    Convert mp4 file to m3u8 file.
    :param input_path: mp4 file path
    :param output_path: m3u8 file path
    :param base_url: base url
    :param buffer_sec: buffer seconds
    :return: None
    """
    if output_path.exists():
        return
    time.sleep(buffer_sec)
    # Convert to m3u8 file.
    command = ['ffmpeg', '-re', '-i', str(input_path),
               '-c:v', 'copy',
               '-r', '24',
               '-c:a', 'aac', '-b:a', '128k', '-strict', '-2',
               '-f', 'hls',
               '-hls_time', '2',
               '-hls_playlist_type', 'event',
               '-hls_segment_filename', f'{output_path.parent}/video%3d.ts',
               '-hls_base_url', base_url,
               '-timeout', '0.1',
               '-flags', '+global_header',
               str(output_path)]
    command_str = ' '.join(command)
    logger.info(f"ffmpeg command: {command_str}")
    subprocess.call(command)
    logger.info(f"ffmpeg command: {command_str}")


def upload_hls_files(output_path: Path, uuid: str, bucket_manager: BucketManager) -> None:
    """
    open m3u8 file then check .ts files.
    If fined .ts file, upload to GCS.
    :param output_path: m3u8 file path
    :param uuid: session id
    :param bucket_manager: BucketManager instance
    :return: None
    """
    wait_time = 0
    wait_range = 0.1
    end_time = 10

    uploaded_ts_list = []
    while wait_time < end_time:
        time.sleep(wait_range)
        if not output_path.exists(): continue
        with open(output_path, "r") as f:
            lines = f.readlines()
            for line in lines:
                line = line.strip()
                if not line.endswith(".ts"): continue
                ts_file = line.split('/')[-1]
                if ts_file in uploaded_ts_list:
                    # if ts_file create_at over 10 seconds, overwrite blank file.
                    if time.time() - os.path.getctime(output_path.parent / ts_file) > 10:
                        logger.info(f'Overwrite blank file. {ts_file}')
                        with open(output_path.parent / ts_file, 'wb') as f:
                            f.write(b'')
                    continue
                ts_path = Path(f"movie/{uuid}/{ts_file}")
                if ts_path.exists():
                    bucket_manager.upload_file(str(ts_path), str(ts_path))
                    bucket_manager.make_public(str(ts_path))
                    uploaded_ts_list.append(ts_file)
                    logger.info(f'new uploaded ts_file: {ts_file}')
                    wait_time = 0
        wait_time += wait_range
