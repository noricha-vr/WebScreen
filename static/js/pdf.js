'use static';

async function fetchMovieUrl() {
    let request_url = `/api/pdf-to-movie/`;
    console.log(`Requesting ${request_url}`);
    let formData = new FormData();
    formData.append('pdf', document.getElementById('files').files[0]);
    return await fetch(request_url, {
        method: 'POST',
        body: formData
    });
}

function addEventListeners() {
    submitButton.addEventListener('click', submit);
}

addEventListeners();