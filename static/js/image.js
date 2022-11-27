'use static';

async function fetchMovieUrl() {
    let widthHeight = document.querySelector('input[name="width_height"]:checked').value.split('x');
    let request_url = `/api/image-to-movie/?width=${widthHeight[0]}`;
    console.log(`Requesting ${request_url}`);
    return await fetch(request_url, {
        method: 'POST',
        body: new FormData(document.getElementById('image_form')),
    });
}

function addEventListeners() {
    submitButton.addEventListener('click', submit);
}

addEventListeners();