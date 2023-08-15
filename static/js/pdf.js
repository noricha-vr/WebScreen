'use static';

async function fetchMovieUrl() {
    const fileInput = document.getElementById('files');
    const file = fileInput.files?.[0];
    fileSizeValidation(file, 'This file is too large. File size should be smaller than 32MB.')

    let request_url = `/api/pdf-to-movie/`;
    console.log(`Requesting ${request_url}`);
    let frame_sec = parseInt((document.querySelector('input[name="frame_sec"]:checked')).value);
    let formData = new FormData();
    formData.append('pdf', file);
    formData.append('frame_sec', frame_sec.toString());

    return await fetch(request_url, {
        method: 'POST',
        body: formData
    });
}


function fileSizeValidation(file, message) {
    const maxFileSize = 32 * 1024 * 1024; // 32MB in bytes
    if (file && file.size > maxFileSize) {
        alert(message);
        window.location.reload()
    }
}


function addEventListeners() {
    submitButton.addEventListener('click', submit);
}

addEventListeners();
