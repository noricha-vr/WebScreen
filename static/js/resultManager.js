function copyToClipboard(e) {
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
    navigator.clipboard.writeText(copyText).then(r => {
        console.log('copied');
        e.target.textContent = 'Copied!';
        setTimeout(() => {
            e.target.textContent = 'Copy';
        }, 2000);
    });
}

function pasteFromClipboard(targetTextElement) {
    navigator.clipboard.readText().then(text => {
        targetTextElement.value = text;
    });
}


function saveResult(result) {
    /*
    Save result in cookie.
     */
    if (result.delete_at === null) {
        console.log(`Saving result in cookie: ${result.url}`);
        return;
    }
    let expires = new Date(result.delete_at * 1000);
    let cookie = `${result.name}=${result.url}; expires=${expires.toUTCString()}; path=/`;
    console.log(`Saving result in cookie: ${cookie}`);
    document.cookie = cookie;
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
    return newResult;
}

