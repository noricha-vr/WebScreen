'use strict';

async function fetchMovieUrl() {
    let request_url = `/api/image-to-movie/`;
    const fileInput = document.getElementById('files');
    const files = fileInput.files;
    totalFileSizeValidation(files, 'The total file size is too large. It should be smaller than 32MB.');

    let formData = new FormData();
    for (let i = 0; i < files.length; i++) {
        formData.append('images', files[i]);
    }

    return await fetch(request_url, {
        method: 'POST',
        body: formData
    });
}

function totalFileSizeValidation(files, message) {
    const maxFileSize = 32 * 1024 * 1024; // 32MB in bytes
    let totalSize = 0;

    for (let i = 0; i < files.length; i++) {
        totalSize += files[i].size;
    }

    if (totalSize > maxFileSize) {
        alert(message);
        window.location.reload();
    }
}


function addEventListeners() {
    submitButton.addEventListener('click', submit);
}

addEventListeners();
