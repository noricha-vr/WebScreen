import time
import pyautogui
import requests
from pathlib import Path

image_path = Path("screenshot.jpg")
end_point = "https://screen-capture-7fhttuy7sq-an.a.run.app"
headers = {"X-Token": "f5bd5b07-b7ab-4de7-8990-28e82882c632"}


def post_image():
    myScreenshot = pyautogui.screenshot()
    myScreenshot.save(image_path)
    requests.post(f"{end_point}/api/desktop/", files={"file": open(image_path, "rb")}, headers=headers)
    time.sleep(3)


if __name__ == '__main__':
    while True: post_image()
