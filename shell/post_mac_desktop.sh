#!/bin/bash
# 1. Take a screenshot of your desktop
# 2. Post the image to the following URL "http://0.0.0.0:8080/post_desktop/". post with session_id and image
# 3. Execute 1 - 2 every second

while true;
do
    # Take a screenshot of your desktop
    screencapture -x -t jpg /tmp/desktop.jpg
    # Post the image to the following URL "http://0.0.0.0:8080/post_desktop/"
    curl -X POST -F "file=@/tmp/desktop.jpg" -H 'session_id: xxx' http://0.0.0.0:8080/desktop-image/
    sleep 1
done