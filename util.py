import glob
from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np
import pdf2image as pdf2image


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


def pdf_to_image(pdf_bytes: bytes, image_dir: Path):
    """
    Convert pdf to image.
    :param pdf_bytes: pdf file bytes.
    :param image_dir: image directory path.
    :return:
    """
    image_paths = [image_path for image_path in pdf2image.convert_from_bytes(pdf_bytes)]
    for i, image_path in enumerate(image_paths):
        image_path.save(image_dir / f"{str(i).zfill(3)}.png")
