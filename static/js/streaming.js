const videoElem = document.getElementById("video");
const startElem = document.getElementById("start");
const stopElem = document.getElementById("stop");
const progressAreaElm = document.getElementById("progress-bar-area");
const mineType = 'video/mp4';
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
            frameRate: 24,
            height: 720,
            mediaSource: "screen",
            width: 1280,
        }
    });
}

function createRecorder(stream, mimeType) {
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
        if (recordedChunks.length > 0 && recordedChunks.length % 50 === 0) {
            console.log('uploading...');
            await uploadMovie(recordedChunks, uuid, is_first);
            recordedChunks = [];
        }
    };
    mediaRecorder.onstop = async function (e) {
        progressAreaElm.classList.remove('visually-hidden');
        let progress = startProgressBar(getIntervalSpeed());
        this.stream.getTracks().forEach(track => track.stop());
        let res = await uploadMovie(recordedChunks);
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

async function uploadMovie(recordedChunks, uuid, is_first) {
    console.log(`Post movie size: ${recordedChunks.length / 1024 / 1024} MB`);
    const formData = new FormData();
    formData.append("chunk", recordedChunks);
    formData.append("uuid", uuid);
    formData.append("is_first", is_first);
    let url = `/api/stream/`;
    let res = await fetch(url, {
        method: 'POST',
        body: formData
    })
    URL.revokeObjectURL(blob); // clear from memory
    return res;
}

async function startRecording() {
    let stream = await recordScreen();
    let mimeType = mineType;
    startElem.classList.add('visually-hidden');
    stopElem.classList.remove('visually-hidden');
    mediaRecorder = createRecorder(stream, mimeType);
}

function stopRecording() {
    mediaRecorder.stop();
}