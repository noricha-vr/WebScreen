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
    copyButton.textContent = 'Copy';
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
        // save result to cookie
        saveResult(data);
        // set movie_url
        movieUrlElement.href = data.url;
        movieUrlElement.textContent = data.url;
        // show movie_url
        resultArea.className = '';
    } else {
        alert('error');
    }
}


function copyToClipboard(e) {
    // Find out what number the parent element of target is
    let target = e.target.parentNode;
    let targetNumber = 0;
    while (target = target.previousElementSibling) {
        targetNumber++;
    }
    console.log(`targetNumber: ${targetNumber}`);
    // copy target value of element to clipboard
    let targetResult = document.getElementsByName('result')[targetNumber];
    let copyText = targetResult.getElementsByTagName('a')[0];
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


function saveResult(result) {
    /*
    Save result in cookie.
     */
    let expires = new Date(result.delete_at * 1000);
    document.cookie = `${result.url}=${result.url}; expires=${expires.toUTCString()}; path=/`;
}

function addResultsToPage() {
    /*
    If there are results in cookie, add them to page.
     */
    let resultsElement = document.getElementById('results');
    let resultElement = document.getElementsByName('result')[0];
    // Get all cookies
    let cookies = document.cookie.split(';');
    for (let cookie of cookies) {
        let [key, value] = cookie.split('=');
        // check if value starts with http
        if (value.startsWith('http')) {
            console.log(`key: ${key}, value: ${value}`);
            // clone result element, then set key and value.
            let newResult = resultElement.cloneNode(true);
            newResult.classList.remove('visually-hidden');
            let aTag = newResult.getElementsByTagName('a')[0]
            aTag.href = value;
            aTag.textContent = key.substring(0, 90);
            // add copy button event listener
            let copyButton = newResult.getElementsByTagName('button')[0];
            copyButton.addEventListener('click', copyToClipboard);
            resultsElement.appendChild(newResult);
        }
    }
}

window.onload = addResultsToPage;