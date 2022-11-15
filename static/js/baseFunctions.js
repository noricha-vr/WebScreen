'use static';
const submitButton = document.getElementById('submit');
const loadingImage = document.getElementById('loading');
const inputUrl = document.getElementById('url');
const pasteButton = document.getElementById('paste_button');
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
    // Hide submit button and result area. Show loading image.
    submitButton.classList.add('visually-hidden');
    loadingImage.classList.remove('visually-hidden');
    // fetch movie url
    let response = await fetchMovieUrl()
    // show result area and copy button.
    submitButton.classList.remove('visually-hidden');
    loadingImage.classList.add('visually-hidden');

    if (response.status === 200) {
        // set url to movie_url
        let data = await response.json()
        console.log(`data: ${JSON.stringify(data)}`);
        // save result to cookie
        saveResult(data);
        // add result to page
        let newResult = createResultNode(data.url, data.url);
        let resultsElement = document.getElementById('results');
        resultsElement.insertBefore(newResult, resultsElement.firstChild);
    } else {
        alert('error');
    }
}
