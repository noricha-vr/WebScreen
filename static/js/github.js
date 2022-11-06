'use static';

async function fetchMovieUrl() {
    //curl -X 'GET' \
    //   'http://0.0.0.0:8080/api/create_github_movie/?url=https%3A%2F%2Fgithub.com%2Fnoricha-vr%2Fscreen_capture&targets=%2A.py&width=1280&height=720&limit_height=50000&scroll_each=200&catch=true' \
    //   -H 'accept: application/json'
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