import glob
import cv2

fps = 0.2  # 1フレームあたりのスライド数。1.0で1スライド/1秒、2.0で2スライド/1秒


def image2mp4(image_dir: str, movie_path: str):
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
