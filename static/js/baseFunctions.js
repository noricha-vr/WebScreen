'use static';
const submitButton = document.getElementById('submit');
const inputUrl = document.getElementById('url');
const pasteButton = document.getElementById('paste_button');
const pageHeightLabel = document.getElementById('page_height_label');
const pageHeightSlider = document.getElementById('page_height_slider');
const progressBar = document.getElementById('progress_bar');

function selectAllText(e) {
    e.target.setSelectionRange(0, e.target.value.length);
}

async function fetchMovieUrl() {
    // abstract
    throw new Error('Not implemented');
}


async function submit() {
    // Hide submit button and result area. Show loading image.
    submitButton.classList.add('visually-hidden');
    progressBar.parentNode.classList.remove('visually-hidden');
    let progress = startProgressBar(getIntervalSpeed());
    // fetch movie url
    let response = await fetchMovieUrl()
    stopProgressBar(progress);
    // show result area and copy button.
    submitButton.classList.remove('visually-hidden');
    progressBar.parentNode.classList.add('visually-hidden');

    if (response.ok) {
        // set url to movie_url
        let data = await response.json()
        console.log(`Response data: ${JSON.stringify(data)}`);
        // save result to cookie
        data.name = data.url;
        if (inputUrl !== null) {
            data.name = inputUrl.value.replaceAll('=', '-');
        }
        saveResult(data);
        // add result to page
        let newResult = createResultNode(data.name, data.url);
        changeButtonColor(newResult);
        let resultsElement = document.getElementById('results');
        resultsElement.insertBefore(newResult, resultsElement.firstChild);
    } else {
        alert('error');
    }
}

function getIntervalSpeed() {
    let speed = 50;
    if (pageHeightSlider === null) {
        return speed;
    }
    // if page height is 1000, interval is 50ms.
    return pageHeightSlider.value / 200;
}

function startProgressBar(interval) {
    let width = 0;
    let add = 0.1;
    let progress = setInterval(() => {
        progressBar.style = `width: ${width}%`;
        width += add;
        if (width >= 100) {
            width = 0;
        }
    }, interval);
    return progress;
}

function stopProgressBar(progress) {
    clearInterval(progress);
    progressBar.style = 'width: 0%';
}

function changeButtonColor(element) {
    let button_color = 'btn-primary';
    let div_classes = ['bg-warning', 'rounded', 'alert', 'alert-primary'];
    let button = element.querySelector('button');
    button.classList.remove('btn-outline-primary');
    button.classList.add(button_color);
    div_classes.forEach((c) => {
        element.classList.add(c)
    });
    setTimeout(() => {
        div_classes.forEach((c) => {
            element.classList.remove(c)
        });
        button.classList.add('btn-outline-primary');
        button.classList.remove(button_color);
    }, 10000);
}

function selectActiveMenu() {
    let naviItems = document.getElementsByClassName('nav-link');
    for (let item of naviItems) {
        if (item.href === location.href) {
            item.classList.add('active');
        }
    }
}

function showResultMessage() {
    let results = document.getElementById('results');
    if (results.children.length > 1) {
        document.getElementById('result-message').classList.remove('visually-hidden');
    }
}

window.onload = () => {
    selectActiveMenu();
    addResultsToPage();
    showResultMessage();
}