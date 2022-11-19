const videoElem = document.getElementById("video");
const startElem = document.getElementById("start");
const stopElem = document.getElementById("stop");
const mineType = 'video/mp4';
let mediaRecorder = null;

// Set event listeners for the start and stop buttons
startElem.addEventListener("click", function (evt) {
    startRecording();
    // testStartCapture();
}, false);

stopElem.addEventListener("click", function (evt) {
    stopRecording();
}, false);

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
    mediaRecorder.onstop = async function (e) {
        this.stream.getTracks().forEach(track => track.stop());
        await uploadMovie(recordedChunks);
        recordedChunks = [];
    };
    let interval = 200; // For every 200ms the stream data will be stored in a separate chunk.
    mediaRecorder.start(interval);
    return mediaRecorder;
}

async function uploadMovie(recordedChunks) {
    const blob = new Blob(recordedChunks, {
        type: mineType
    });
    let file = new File([blob], "test.mp4");
    console.log(`Post movie size: ${file.size / 1024} KB, type: ${file.type} name: ${file.name}`);
    const formData = new FormData();
    formData.append("file", file);
    let url = `/api/save-movie/`;
    let res = await fetch(url, {
        method: 'POST',
        body: formData
    })
    if(res.ok){
        let data = await res.json();
        console.log(`movie url: ${data.url}`);
        saveResult(data);
        // add result to page
        let newResult = createResultNode(`ScreenRecoding-${new Date().getTime()}`, data.url);
        changeButtonColor(newResult);
        let resultsElement = document.getElementById('results');
        resultsElement.insertBefore(newResult, resultsElement.firstChild);
    }
    console.log(`upload result: ${res.ok}`);
    URL.revokeObjectURL(blob); // clear from memory
}

async function startRecording() {
    let stream = await recordScreen();
    let mimeType = mineType;
    mediaRecorder = createRecorder(stream, mimeType);
}

function stopRecording() {
    mediaRecorder.stop();
}