const videoElem = document.getElementById("video");
const logElem = document.getElementById("log");
const startElem = document.getElementById("start");
const stopElem = document.getElementById("stop");
const mineType = 'video/mp4';
let mediaRecorder = null;

let displayMediaOptions = {
    video: {
        cursor: "always"
    },
    audio: false
};

// Set event listeners for the start and stop buttons
startElem.addEventListener("click", function (evt) {
    startRecording();
    // testStartCapture();
}, false);

stopElem.addEventListener("click", function (evt) {
    stopRecording();
}, false);

let interval = null;

async function recordScreen() {
    return await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { mediaSource: "screen" }
    });
}

function createRecorder(stream, mimeType) {
    // the stream data is stored in this array
    let recordedChunks = [];

    const mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = function (e) {
        if (e.data.size > 0) {
            recordedChunks.push(e.data);
        }
    };
    mediaRecorder.onstop = async function () {
        // saveFile(recordedChunks);
        await uploadMovie(recordedChunks);
        recordedChunks = [];
    };
    mediaRecorder.start(200); // For every 200ms the stream data will be stored in a separate chunk.
    return mediaRecorder;
}

async function uploadMovie(recordedChunks) {
    const blob = new Blob(recordedChunks, {
        type: mineType
    });
    let objectURL = URL.createObjectURL(blob);
    var reader = new FileReader();
    reader.readAsDataURL(objectURL);
    reader.onload = async function (e) {
        console.log('DataURL:', e.target.result);
        let res = await postMovie('/api/save-movie/', reader);
        console.log(`upload result: ${res.ok}`);
        URL.revokeObjectURL(blob); // clear from memory
    };
}
// After some time stop the recording by 
async function postMovie(url, movie) {
    let header = {
        'session_id': localStorage.getItem("uuid"),
    }
    console.log(`Post movie size: ${movie.length / 1024} KB`);
    let formData = new FormData();
    formData.append('movie', movie);
    let res = await fetch(url, formData, {
        method: 'POST',
        headers: header,
        responseType: 'blob',
    })
    return res;
}

let formData = new FormData();
formData.append('movie', 'test.mp4');
let res = fetch('/api/save-movie/', formData, {
    method: 'POST',
})
console.log(`upload result: ${res.ok}`);

async function startRecording() {
    let stream = await recordScreen();
    let mimeType = mineType;
    mediaRecorder = createRecorder(stream, mimeType);
}

function stopRecording() {
    mediaRecorder.stop();
}

function dumpOptionsInfo() {
    const videoTrack = videoElem.srcObject.getVideoTracks()[0];

    console.info("Track settings:");
    console.info(JSON.stringify(videoTrack.getSettings(), null, 2));
    console.info("Track constraints:");
    console.info(JSON.stringify(videoTrack.getConstraints(), null, 2));
}


function uuidv4() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
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
