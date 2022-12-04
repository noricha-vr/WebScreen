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
    // testStartCapture();
}, false);

stopElem.addEventListener("click", function (evt) {
    stopCapture();
}, false);

let interval = null;

async function startCapture() {
    logElem.innerHTML = "";
    let url = `${location.origin}/api/receive-image/`;
    try {
        videoElem.srcObject = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
    } catch (err) {
        console.error("Error: " + err);
    }
    console.log(`count of tracks: ${videoElem.srcObject.getTracks().length}`);
    interval = setInterval(async () => {
        let base64 = await captureImage(videoElem.srcObject.getVideoTracks()[0]);
        document.getElementById('photo').src = base64;
        let res = await postImage(url, base64);
        if (res.ok) {
            console.log(`postImage success`);
        } else {
            console.log(`postImage fail`);
        }
    }, 5000);
}

function stopCapture(evt) {
    let tracks = videoElem.srcObject.getTracks();

    tracks.forEach(track => track.stop());
    videoElem.srcObject = null;
    clearInterval(interval);
}


async function captureImage(track) {
    // videoElem.srcObject into canvas. Then save as image.
    // const track = videoElem.srcObject.getCanvasTrack(); // MediaStream.getVideoTracks()[0]
    let capture = new ImageCapture(track);
    let bitmap = await capture.grabFrame()
    // Stop sharing
    // track.stop();
    // Draw the bitmap to canvas
    let canvas = document.querySelector("canvas");
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
        'session_id': localStorage.getItem("uuid"),
    }
    console.log(`Post image size: ${image.length / 1024} KB`);
    let res = await fetch(url, {
        method: 'POST',
        headers: header,
        body: image,
    })
    return res;
}


function dumpOptionsInfo() {
    const videoTrack = videoElem.srcObject.getVideoTracks()[0];

    console.info("Track settings:");
    console.info(JSON.stringify(videoTrack.getSettings(), null, 2));
    console.info("Track constraints:");
    console.info(JSON.stringify(videoTrack.getConstraints(), null, 2));
}


window.onload = function () {
    let uuid = localStorage.getItem("uuid");
    if (uuid === null) {
        uuid = uuidv4();
        localStorage.setItem("uuid", uuid);
        console.log(`created uuid`);
    }
    console.log(`current uuid: ${uuid}`);
    document.getElementsByName("uuid").forEach(e => e.innerText = uuid);
    document.getElementsByName("origin").forEach(e => e.innerText = location.origin);
    let url = `${location.origin}/desktop/${uuid}/`;
    document.getElementById("player_url").innerText = url;
    document.getElementById("player_url").href = url;
}