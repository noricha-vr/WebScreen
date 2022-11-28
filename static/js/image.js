'use static';

async function fetchMovieUrl() {
    let request_url = `/api/image-to-movie/`;
    console.log(`Requesting ${request_url}`);
    let formData = new FormData();
    let files = document.getElementById('files').files;
    for (let i = 0; i < files.length; i++) {
        formData.append('images', files[i]);
    }
    return await fetch(request_url, {
        method: 'POST',
        body: formData
    });
}

function addEventListeners() {
    submitButton.addEventListener('click', submit);
}

addEventListeners();