#!/bin/bash
# 1. Take a screenshot of your desktop
# 2. Post the image to the following URL "http://0.0.0.0:8080/api/desktop/". post with session_id and image
# 3. Execute 1 - 2 every second

# local test
while true;
do
    screencapture -x -t jpg /tmp/desktop.jpg
    curl -X POST -F "file=@/tmp/desktop.jpg" -H 'X-Token: xxx' http://0.0.0.0:8080/api/desktop/
    sleep 3
done

# example
#while true;
#do
#    screencapture -x -t jpg /tmp/desktop.jpg
#    curl -X POST -F "file=@/tmp/desktop.jpg" -H 'X-Token: xxx' https://screen-capture-7fhttuy7sq-an.a.run.app/api/desktop/
#    sleep 3
#done