'use static';

async function fetchMovieUrl() {
    let url = encodeURI(document.getElementById('url').value)
    if (!url.startsWith('http')) {
        return new Response('Invalid URL', {status: 400});
    }
    let wait_time = parseInt(document.querySelector('input[name="wait_time"]:checked').value);
    let data = JSON.stringify({
        'url': url,
        'lang': navigator.language,
        'page_height': pageHeightSlider.value,
        'wait_time': wait_time,
    })
    console.log(`POST data: ${data}`);
    let request_url = '/api/url-to-movie/';
    let header = {
        'Content-Type': 'application/json',
    }
    return await fetch(request_url, {
        method: 'POST',
        headers: header,
        body: data,
    });
}

function addEventListeners() {
    submitButton.addEventListener('click', submit);
    inputUrl.addEventListener('focus', selectAllText);
    pageHeightSlider.addEventListener('change', (e) => {
        pageHeightLabel.textContent = e.target.value;
    });
    pasteButton.addEventListener('click', () => {
        pasteFromClipboard(inputUrl);
    });
}

addEventListeners();