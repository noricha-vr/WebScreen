'use static';

async function fetchMovieUrl() {
    let url = encodeURI(document.getElementById('url').value)
    if (!url.startsWith('http')) {
        return new Response('Invalid URL', {status: 400});
    }
    let widthHeight = document.querySelector('input[name="width_height"]:checked').value.split('x');
    let cache = document.getElementById('catch').checked;
    let request_url = `/api/create_movie/?url=${url}&page_height=${pageHeightSlider.value}` +
        `&width=${widthHeight[0]}&height=${widthHeight[1]}&lang=${navigator.language}&catch=${cache}`;
    console.log(`Requesting ${request_url}`);
    return await fetch(request_url, {
        method: 'GET',
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