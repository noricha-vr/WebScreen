const videoElem = document.getElementById("video");
const logElem = document.getElementById("log");
const startElem = document.getElementById("start");
const stopElem = document.getElementById("stop");

// Options for getDisplayMedia()

var displayMediaOptions = {
    video: {
        cursor: "always"
    },
    audio: false
};

// Set event listeners for the start and stop buttons
startElem.addEventListener("click", function (evt) {
    startCapture();
}, false);

stopElem.addEventListener("click", function (evt) {
    stopCapture();
}, false);

async function startCapture() {
    logElem.innerHTML = "";

    try {
        videoElem.srcObject = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
        // dumpOptionsInfo();
        sendVideo();
    } catch (err) {
        console.error("Error: " + err);
    }
}

function stopCapture(evt) {
    let tracks = videoElem.srcObject.getTracks();

    tracks.forEach(track => track.stop());
    videoElem.srcObject = null;
}

function dumpOptionsInfo() {
    const videoTrack = videoElem.srcObject.getVideoTracks()[0];

    console.info("Track settings:");
    console.info(JSON.stringify(videoTrack.getSettings(), null, 2));
    console.info("Track constraints:");
    console.info(JSON.stringify(videoTrack.getConstraints(), null, 2));
}

// send the video to the server by streaming fetch. post url is /api/upload/video/
function sendVideo() {
    console.log("sending video");
    const _videoTrack = videoElem.srcObject.getVideoTracks()[0];
    const mediaRecorder = new MediaRecorder(_videoTrack);
    const stream = new ReadableStream({
        start(controller) {
            mediaRecorder.ondataavailable = (event) => {
                controller.enqueue(event.data);
            };
            mediaRecorder.onstop = () => {
                controller.close();
            };
        }
    })
    mediaRecorder.ondataavailable = function (e) {
        fetch('/api/upload/video/', {
            method: 'POST',
            body: stream,
            duplex: "half",
        }).then(function (response) {
            console.log(response);
        });
    };
    mediaRecorder.start();
    setTimeout(() => {
        mediaRecorder.stop();
    }, 5000);
}
