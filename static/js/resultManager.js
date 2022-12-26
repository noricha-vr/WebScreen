'use static';


function downloadMovie(e) {
    /*
    Download movie from server.
     */
    // Find out what number the parent element of target is
    let target = e.target.parentNode;
    let targetNumber = 0;
    while (target = target.previousElementSibling) {
        targetNumber++;
    }
    console.log(`targetNumber: ${targetNumber}`);
    // copy target value of element to clipboard
    let targetResult = document.getElementsByName('result')[targetNumber];
    let copyText = targetResult.getElementsByTagName('a')[0];
    let url = copyText.href;
    let words = copyText.textContent.split('/');
    fetch(url).then(r => {
        r.blob().then(blob => {
            let a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = words[words.length - 1];
            a.click();
        });
    });
}


function showResultMessage() {
    let results = document.getElementById('results');
    if (results.children.length > 1) {
        document.getElementById('result-message').classList.remove('visually-hidden');
    }
}

function addResultsToPage() {
    /*
    If there are results in cookie, add them to page.
     */
    let resultsElement = document.getElementById('results');
    // Get all cookies
    let cookies = document.cookie.split(';').reverse();
    for (let cookie of cookies) {
        if (cookie.length === 0) {
            continue;
        }
        let [key, value] = cookie.split('=');
        // check if value starts with http
        if (value.startsWith('http')) {
            // clone result element, then set key and value.
            let newResult = createResultNode(key, value);
            resultsElement.appendChild(newResult);
        }
    }
}

function createResultNode(text, href) {
    /*
    Create result node.
     */
    let resultElement = document.getElementsByName('result')[0];
    // clone result element. Remove visually-hidden.
    let newResult = resultElement.cloneNode(true);
    newResult.classList.remove('visually-hidden');
    // set text and href
    let aTag = newResult.getElementsByTagName('a')[0]
    aTag.href = href;
    aTag.textContent = text.substring(0, 90);
    // add copy button event listener
    let copyButton = newResult.getElementsByTagName('button')[0];
    copyButton.addEventListener('click', copyToClipboard);
    let donwloadButton = newResult.getElementsByTagName('button')[1];
    donwloadButton.addEventListener('click', downloadMovie);
    return newResult;
}

