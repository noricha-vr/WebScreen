'use static';

async function fetchMovieUrl() {
    let settings = {
        width: document.getElementById('width').value,
        height: document.getElementById('height').value,
    }
    let request_url = `/api/create_image_movie/?width=${settings.width}&height=${settings.height}`;
    console.log(`Requesting ${request_url}`);
    return await fetch(request_url, {
        method: 'POST',
        //Uncaught (in promise) TypeError: Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.
        //body: new FormData(document.getElementById('image_form')),
        body: new FormData(document.getElementById('image_form')),
    });
}