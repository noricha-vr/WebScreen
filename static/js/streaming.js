const videoElem = document.getElementById("video");
const startElem = document.getElementById("start");
const stopElem = document.getElementById("stop");
const progressAreaElm = document.getElementById("progress-bar-area");
const mineType = 'video/mp4';
let mediaRecorder = null;

// Set event listeners for the start and stop buttons
startElem.addEventListener("click", function (evt) {
    startRecording();
}, false);

stopElem.addEventListener("click", function (evt) {
    stopRecording();
}, false);

async function recordScreen() {
    return await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: {mediaSource: "screen"}
    });
}

function createRecorder(stream, mimeType) {
    // the stream data is stored in this array
    const mediaRecorder = new MediaRecorder(stream);
    let recordedChunks = [];
    // 5秒ごとに動画をアップロードする
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
            recordedChunks.push(e.data);
        }
        if (recordedChunks.length > 0 && recordedChunks.length % 100 === 0) {
            console.log('uploading...');
            uploadMovie(recordedChunks);
            recordedChunks = [];
        }
    };
    mediaRecorder.onstop = async function (e) {
        progressAreaElm.classList.remove('visually-hidden');
        let progress = startProgressBar(getIntervalSpeed());
        this.stream.getTracks().forEach(track => track.stop());
        let res = await uploadMovie(recordedChunks);
        await saveAndShowResult(res);
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

async function uploadMovie(recordedChunks) {
    let blob = new Blob(recordedChunks, {
        type: mineType
    });
    let file = new File([blob], "test.mp4");
    console.log(`Post movie size: ${file.size / 1024} KB, type: ${file.type} name: ${file.name}`);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("session_id", 'test');
    let url = `/api/stream/`;
    let res = await fetch(url, {
        method: 'POST',
        body: formData
    })
    URL.revokeObjectURL(blob); // clear from memory
    return res;
}

async function saveAndShowResult(res) {
    if (res.ok) {
        let data = await res.json();
        console.log(`movie url: ${data.url}`);
        let date = new Date();
        // data.name format is `ScreenRecoding_YYYY-MM-DD_HH-MM-SS`
        data.name = `ScreenRecoding_${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` +
            `_${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}`;
        saveResult(data);
        // add result to page
        let newResult = createResultNode(data.name, data.url);
        changeButtonColor(newResult);
        let resultsElement = document.getElementById('results');
        resultsElement.insertBefore(newResult, resultsElement.firstChild);
    } else {
        alert('Error: ' + res.status);
    }
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