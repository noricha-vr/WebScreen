'use static';

async function fetchMovieUrl() {
    let url = encodeURI(document.getElementById('url').value)
    if (!url.startsWith('http')) {
        return new Response('Invalid URL', {status: 400});
    }
    let [width, height] = document.querySelector('input[name="width_height"]:checked').value.split('x');
    let cache = document.getElementById('catch').checked;
    let wait_time = parseInt(document.querySelector('input[name="wait_time"]:checked').value);
    let data = JSON.stringify({
        'url': url,
        'lang': navigator.language,
        'page_height': pageHeightSlider.value,
        'width': width,
        'height': height,
        'wait_time': wait_time,
        'catch': cache === true ? 1 : 0,
    })
    console.log(`POST data: ${data}`);
    let request_url = '/api/create_movie/';
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