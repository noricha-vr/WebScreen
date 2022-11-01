const CREATE_MOVIE_URL = '/api/create_movie/';

const submitButton = document.getElementById('submit');
const loadingImage = document.getElementById('loading');
const movieUrlElement = document.getElementById('movie_url');
const copyButton = document.getElementById('copy');
const resultArea = document.getElementById('result');

async function createMovie(settings) {
    let request_url = `${CREATE_MOVIE_URL}?url=${settings.url}&max_page_height=${settings.max_page_height}` +
        `&width=${settings.width}&height=${settings.height}`;
    console.log(`Requesting ${request_url}`);
    return await fetch(request_url, {
        method: 'GET',
    });
}


// when click submit button, create movie
submitButton.addEventListener('click', async () => {
    // Hide submit button and result area.
    submitButton.className = 'visually-hidden';
    resultArea.className = 'visually-hidden';
    // show loading button. remove visually-hidden class
    loadingImage.className = '';

    let settings = {
        url: encodeURI(document.getElementById('url').value),
        max_page_height: document.getElementById('max_page_height').value,
        width: document.getElementById('width').value,
        height: document.getElementById('height').value,
    }
    console.log(`movie: ${JSON.stringify(settings)}`);
    let response = await createMovie(settings)
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
        movieUrlElement.innerHTML = data.url;
        // show movie_url
        resultArea.className = '';
    } else {
        alert('error');
    }
});

function copyToClipboard() {
    let copyText = movieUrlElement.href;
    navigator.clipboard.writeText(copyText).then(r => {
        console.log('copied');
        copyButton.innerHTML = 'Copied!';
    });
}

// when click copy button, copy movie_url to clipboard
copyButton.addEventListener('click', () => {
    copyToClipboard();
})