'use static';

async function fetchMovieUrl() {
    let url = document.getElementById('url').value;
    let targets = document.getElementById('targets').value;
    let [width, height] = document.querySelector('input[name="width_height"]:checked').value.split('x');
    let cache = document.getElementById('catch').checked;
    let request_url = `/api/create_github_movie/`
    console.log(`Requesting ${request_url}`);
    let data = {
        "url": url,
        "targets": targets,
        "width": width,
        "height": height,
        "cache": cache == true ? 1 : 0,
    }
    console.log(`data: ${JSON.stringify(data)}`);
    return await fetch(request_url ,{
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
            'Content-Type': 'application/json',
        },
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