'use static';

function getInputElement(e) {
    let rowElm = e.target.parentNode.parentNode;
    return rowElm.getElementsByTagName('input')[0];
}


function copyToClipboard(e) {
    let input = getInputElement(e)
    // copy target value of element to clipboard
    navigator.clipboard.writeText(input.textContent).then(r => {
        console.log(`copied: ${input.textContent}`);
        e.target.textContent = 'Copied!';
        return new Promise(resolve => setTimeout(resolve, 2000));
    }).then(() => {
        e.target.textContent = 'Copy';
    });
}


function downloadMovie(e) {
    /*
    Download movie from server.
     */
    let input = getInputElement(e);
    let url = input.textContent;
    let words = input.value.split('/');
    fetch(url).then(r => {
        r.blob().then(blob => {
            let a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = words[words.length - 1];
            a.click();
        }).then(() => {
            URL.revokeObjectURL(a.href);
        });
    });
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
    let aTag = newResult.getElementsByTagName('input')[0]
    // aTag.href = href;
    aTag.value = text.substring(0, 90);
    aTag.textContent = href;
    // add copy button event listener
    let copyButton = newResult.getElementsByTagName('button')[0];
    copyButton.addEventListener('click', copyToClipboard);
    let donwloadButton = newResult.getElementsByTagName('button')[1];
    donwloadButton.addEventListener('click', downloadMovie);
    return newResult;
}

window.onload = () => {
    addResultsToPage();
}