'use static';

async function fetchMovieUrl() {
    let url = document.getElementById('url').value;
    let targets = document.getElementById('targets').value;
    let widthHeight = document.querySelector('input[name="width_height"]:checked').value.split('x');
    let cache = document.getElementById('catch').checked;
    let request_url = `/api/create_github_movie/?url=${url}&targets=${targets}` +
        `&width=${widthHeight[0]}&height=${widthHeight[1]}&catch=${cache}`;
    console.log(`Requesting ${request_url}`);
    return await fetch(request_url, {
        method: 'GET',
    });
}

function addEventListeners() {
    submitButton.addEventListener('click', submit);
    inputUrl.addEventListener('focus', selectAllText);
    pasteButton.addEventListener('click', () => {
        pasteFromClipboard(inputUrl);
    });
}

addEventListeners();