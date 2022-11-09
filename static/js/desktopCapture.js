const videoElem = document.getElementById("video");
const logElem = document.getElementById("log");
const startElem = document.getElementById("start");
const stopElem = document.getElementById("stop");

// Options for getDisplayMedia()

let displayMediaOptions = {
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
    let url = `${location.origin}/api/desktop-image/`;
    try {
        videoElem.srcObject = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
        let base64 = await captureImage(videoElem.srcObject.getVideoTracks()[0]);
        console.log(`base64: ${base64}`);
        document.getElementById('photo').src = base64;
        if (base64.length > 100) {
            await postImage(url, base64);
        } else {
            console.log(`base64 is too short: ${base64.length}`);
        }
    } catch (err) {
        console.error("Error: " + err);
    }
}

function stopCapture(evt) {
    let tracks = videoElem.srcObject.getTracks();

    tracks.forEach(track => track.stop());
    videoElem.srcObject = null;
}


async function captureImage(track) {
    // videoElem.srcObject into canvas. Then save as image.
    const canvas = document.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    // const track = videoElem.srcObject.getCanvasTrack(); // MediaStream.getVideoTracks()[0]
    let capture = new ImageCapture(track);
    let bitmap = await capture.grabFrame()
    // Stop sharing
    track.stop();
    // Draw the bitmap to canvas
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    // Grab blob from canvas
    return canvas.toDataURL('image/png', 0.5);
    // var canvas = document.createElement('canvas');
    // canvas.width = videoElem.videoWidth;
    // canvas.height = videoElem.videoHeight;
    // canvas.getContext('2d')
    //     .drawImage(videoElem, 0, 0, canvas.width, canvas.height);
    // return canvas.toDataURL('image/jpeg', 0.5);
}

async function postImage(url, image) {
    let header = {
        'Content-Type': 'application/image',
        'session_id': '1234567890',
    }
    console.log(`image: ${image}`);
    let res = await fetch(url, {
        method: 'POST',
        headers: header,
        body: image,

    })
    console.log(`Response: ${res.status} ${res.body}`);
}


function dumpOptionsInfo() {
    const videoTrack = videoElem.srcObject.getVideoTracks()[0];

    console.info("Track settings:");
    console.info(JSON.stringify(videoTrack.getSettings(), null, 2));
    console.info("Track constraints:");
    console.info(JSON.stringify(videoTrack.getConstraints(), null, 2));
}
