'use static';

function getTargets() {
    let targetList = [];
    const targets = document.querySelectorAll('input[name="targets[]"]');
    for (const target of targets) {
        if (target.checked) {
            targetList.push(target.value);
            if (target.value === 'yaml') targetList.push('yml');
        }
    }
    return targetList.join(',');
}


async function fetchMovieUrl() {
    let url = document.getElementById('url').value;
    let targets = getTargets();
    let width = 1280
    let height = 720
    let cache = false;
    let request_url = `/api/create_github_movie/`
    console.log(`Requesting ${request_url}`);
    let data = JSON.stringify({
        "url": url,
        "targets": targets,
        "width": width,
        "height": height,
        "cache": cache === true ? 1 : 0,
    })
    console.log(`POST data: ${data}`);
    return await fetch(request_url, {
        method: 'POST',
        body: data,
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