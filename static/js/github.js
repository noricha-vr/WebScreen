'use static';

async function fetchMovieUrl() {
    let settings = {
        url: document.getElementById('url').value,
        targets: document.getElementById('targets').value,
        width: document.getElementById('width').value,
        height: document.getElementById('height').value,
        catch: document.getElementById('catch').checked,

    }
    let request_url = `/api/create_github_movie/?url=${settings.url}&targets=${settings.targets}&width=${settings.width}&height=${settings.height}&catch=${settings.catch}`;
    console.log(`Requesting ${request_url}`);
    return await fetch(request_url, {
        method: 'GET',
    });
}