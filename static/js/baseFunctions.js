'use static';
const submitButton = document.getElementById('submit');
const loadingImage = document.getElementById('loading');
const inputUrl = document.getElementById('url');
const pasteButton = document.getElementById('paste_button');
const movieUrlElement = document.getElementById('movie_url');
const copyButton = document.getElementById('copy');
const resultArea = document.getElementById('result');
const pageHeightLabel = document.getElementById('page_height_label');
const pageHeightSlider = document.getElementById('page_height_slider');

function selectAllText(e) {
    e.target.setSelectionRange(0, e.target.value.length);
}

async function fetchMovieUrl() {
    // abstract
    throw new Error('Not implemented');
}


async function submit() {
    // Hide submit button and result area.
    submitButton.className = 'visually-hidden';
    resultArea.className = 'visually-hidden';
    // show loading button. remove visually-hidden class
    loadingImage.className = '';
    copyButton.textContent = '動画のURLをコピー';
    // fetch movie url
    let response = await fetchMovieUrl()
    // show submit button
    submitButton.className = 'btn btn-primary';
    // hide loading button
    loadingImage.className = 'visually-hidden';

    if (response.status === 200) {
        // set url to movie_url
        let data = await response.json()
        console.log(`data: ${JSON.stringify(data)}`);
        // set movie_url
        movieUrlElement.href = data.url;
        movieUrlElement.textContent = data.url;
        // show movie_url
        resultArea.className = '';
    } else {
        alert('error');
    }
}


function copyToClipboard() {
    let copyText = movieUrlElement.href;
    navigator.clipboard.writeText(copyText).then(r => {
        console.log('copied');
        copyButton.textContent = 'Copied!';
    });
}

function pasteFromClipboard(targetTextElement) {
    navigator.clipboard.readText().then(text => {
        targetTextElement.value = text;
    });
}
