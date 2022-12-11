const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const copyText = document.getElementById("streaming-url");
let mediaRecorder = null;

// Set event listeners for the start and stop buttons
startButton.addEventListener("click", function (evt) {
    console.log('start recording');
    startRecording();
}, false);

stopButton.addEventListener("click", function (evt) {
    stopRecording();
}, false);

async function recordScreen() {
    return await navigator.mediaDevices.getDisplayMedia({
        audio: {stereo: true},
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
    mediaRecorder.ondataavailable = async (e) => {
        console.log('uploading...');
        uploadMovie([e.data], uuid);
        if (is_first === true) {
            showStreamingURL(uuid);
            is_first = false;
        }
    };
    mediaRecorder.onstop = async function (e) {
        this.stream.getTracks().forEach(track => track.stop());
        let res = await uploadMovie([e.data], uuid);
        let data = await res.json();
        console.log(JSON.stringify(data));
        stopButton.classList.add('visually-hidden');
        startButton.classList.remove('visually-hidden');
        copyText.textContent = '';
    };
    let interval = 200; // For every 200ms the stream data will be stored in a separate chunk.
    mediaRecorder.start(interval);
    return mediaRecorder;
}

async function uploadMovie(recordedChunks, uuid) {
    const mineType = 'video/mp4';
    const blob = new Blob(recordedChunks, {type: mineType});
    let file = new File([blob], "video.mp4");
    console.log(`Post movie size: ${file.size / 1024} KB`);
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
    startButton.classList.add('visually-hidden');
    stopButton.classList.remove('visually-hidden');
    mediaRecorder = createRecorder(stream);
}

function uuidv4() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

function showStreamingURL(uuid) {
    let url = `${window.location.origin}/stream/${uuid}/`;
    let link = document.getElementById('streaming-url');
    link.href = url;
    link.textContent = url;
}

function copyStreamingURL() {
    navigator.clipboard.writeText(copyText.href);
}

function stopRecording() {
    mediaRecorder.stop();
}