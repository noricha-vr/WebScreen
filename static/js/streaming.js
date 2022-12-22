const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const copyText = document.getElementById("streaming-url");
const copyButton = document.getElementById('copy-button');
const setupText = document.getElementById('setup-message');
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
            resizeMode: "crop-and-scale"
        }
    });
}

function createRecorder(stream) {
    let is_first = true;
    const uuid = uuidv4();
    const options = {
        audioBitsPerSecond: 128000,
        videoBitsPerSecond: 2500000,
        mimeType: "video/webm;codecs=h264",
    };
    // the stream data is stored in this array
    const mediaRecorder = new MediaRecorder(stream, options);
    // upload the recorded data to the server
    mediaRecorder.ondataavailable = async (e) => {
        console.log('uploading...');
        uploadMovie([e.data], uuid, is_first);
        if (is_first === true) {
            showStreamingURL(uuid);
            is_first = false;
            copyButton.classList.remove('visually-hidden');
            copyButton.addEventListener('click', copyStreamingURL);
        }
    };
    mediaRecorder.onstop = async function (e) {
        this.stream.getTracks().forEach(track => track.stop());
        let res = await uploadMovie([e.data], uuid);
        let data = await res.json();
        console.log(JSON.stringify(data));

    };
    let interval = 200; // movie upload interval
    mediaRecorder.start(interval);
    return mediaRecorder;
}

async function uploadMovie(recordedChunks, uuid, is_first) {
    const mineType = 'video/webm';
    const blob = new Blob(recordedChunks, {type: mineType});
    let file = new File([blob], "video.mp4");
    console.log(`Post movie size: ${file.size / 1024} KB`);
    const formData = new FormData();
    formData.append("movie", file, file.name);
    formData.append("uuid", uuid);
    formData.append("is_first", is_first);
    let url = `/api/stream/`;
    let res = await fetch(url, {
        method: 'POST',
        body: formData
    })
    return res;
}

async function startRecording() {
    let stream = await recordScreen();
    setupCountdown();
    startButton.classList.add('visually-hidden');
    stopButton.classList.remove('visually-hidden');
    mediaRecorder = createRecorder(stream);
    setTimeout(stopRecording, 1000 * 60 * 30)
}

function uuidv4() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}


function setupCountdown() {
    /*
    * Set up a countdown timer to start recording after 15 seconds.
     */
    setupText.classList.remove('visually-hidden');
    let text = '動画が再生できるようになるまであと ';
    let count = 15;
    let timer = setInterval(function () {
        setupText.textContent = `${text} ${count}秒`;
        count--;
        if (count < 0) {
            clearInterval(timer);
            setupText.textContent = '0';
            setupText.classList.add('visually-hidden');
        }
    }, 1000);
}


function showStreamingURL(uuid) {
    let url = `${window.location.origin}/movie/${uuid}/video.m3u8`;
    let link = document.getElementById('streaming-url');
    // link.href = url;
    link.textContent = url;
}

function copyStreamingURL() {
    navigator.clipboard.writeText(copyText.textContent);
    // change the button text to "Copied!" for 10 seconds
    copyButton.textContent = 'Copied!';
    setTimeout(function () {
        copyButton.textContent = 'Copy';
    }, 10000);

}

function stopRecording() {
    copyButton.classList.add('visually-hidden');
    stopButton.classList.add('visually-hidden');
    startButton.classList.remove('visually-hidden');
    copyText.textContent = '';
    mediaRecorder.stop();
}