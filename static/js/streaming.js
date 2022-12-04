const videoElem = document.getElementById("video");
const startElem = document.getElementById("start");
const stopElem = document.getElementById("stop");
const progressAreaElm = document.getElementById("progress-bar-area");
let mediaRecorder = null;

// Set event listeners for the start and stop buttons
startElem.addEventListener("click", function (evt) {
    console.log('start recording');
    startRecording();
}, false);

stopElem.addEventListener("click", function (evt) {
    stopRecording();
}, false);

async function recordScreen() {
    return await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: {
            cursor: "always",
            displaySurface: "monitor",
            frameRate: 30,
            height: 720,
            mediaSource: "screen",
            width: 1280,
        }
    });
}

function createRecorder(stream) {
    let is_first = true;
    const uuid = uuidv4();
    // the stream data is stored in this array
    const mediaRecorder = new MediaRecorder(stream);
    // upload the recorded data to the server
    let recordedChunks = [];
    mediaRecorder.ondataavailable = async (e) => {
        console.log(`data available, size: ${e.data.size}`);
        if (e.data.size > 0) {
            recordedChunks.push(e.data);
        }
        if (recordedChunks.length > 0 && recordedChunks.length % 10 === 0) {
            console.log('uploading...');
            await uploadMovie(recordedChunks, uuid, is_first);
            is_first = false;
            recordedChunks = [];
        }
    };
    mediaRecorder.onstop = async function (e) {
        progressAreaElm.classList.remove('visually-hidden');
        let progress = startProgressBar(getIntervalSpeed());
        this.stream.getTracks().forEach(track => track.stop());
        let res = await uploadMovie(recordedChunks);
        let data = await res.json();
        console.log(JSON.stringify(data));
        videoElem.href = data.url;
        stopProgressBar(progress);
        progressAreaElm.classList.add('visually-hidden');
        stopElem.classList.add('visually-hidden');
        startElem.classList.remove('visually-hidden');
        recordedChunks = [];
    };
    let interval = 200; // For every 200ms the stream data will be stored in a separate chunk.
    mediaRecorder.start(interval);
    return mediaRecorder;
}

async function uploadMovie(recordedChunks, uuid) {
    const mineType = 'video/mp4';
    const blob = new Blob(recordedChunks, {type: mineType});
    let file = new File([blob], "test.mp4");
    console.log(`Post movie size: ${recordedChunks.length / 1024 / 1024} MB`);
    const formData = new FormData();
    formData.append("movie", file, file.name);
    formData.append("uuid", uuid);
    let url = `/api/stream/`;
    let res = await fetch(url, {
        method: 'POST',
        body: formData
    })
    return res;
}

async function startRecording() {
    let stream = await recordScreen();
    startElem.classList.add('visually-hidden');
    stopElem.classList.remove('visually-hidden');
    mediaRecorder = createRecorder(stream);
}

function uuidv4() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

function stopRecording() {
    mediaRecorder.stop();
}