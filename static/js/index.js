'use static';

async function fetchMovieUrl() {
    let url = encodeURI(document.getElementById('url').value)
    if (!url.startsWith('http')) {
        return new Response('Invalid URL', {status: 400});
    }
    let [width, height] = document.querySelector('input[name="width_height"]:checked').value.split('x');
    let cache = document.getElementById('catch').checked;
    let data = {
        'url': url,
        'lang': navigator.language,
        'page_height': pageHeightSlider.value,
        'width': width,
        'height': height,
        'catch': cache,
    }
    console.log(`data: ${data}`);
    let request_url = '/api/create_movie/';
    let header = {
        'Content-Type': 'application/json',
    }
    return await fetch(request_url, {
        method: 'POST',
        headers: header,
        body: JSON.stringify(data),
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