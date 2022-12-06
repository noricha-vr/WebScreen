'use static';

async function fetchMovieUrl() {
    let request_url = `/api/pdf-to-movie/`;
    console.log(`Requesting ${request_url}`);
    let frame_sec = parseInt(document.querySelector('input[name="frame_sec"]:checked').value);
    let formData = new FormData();
    formData.append('pdf', document.getElementById('files').files[0]);
    formData.append('frame_sec', frame_sec);
    return await fetch(request_url, {
        method: 'POST',
        body: formData
    });
}

function addEventListeners() {
    submitButton.addEventListener('click', submit);
}

addEventListeners();