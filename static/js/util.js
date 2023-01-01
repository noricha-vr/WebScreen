'use static';

function selectAllText(e) {
    e.target.setSelectionRange(0, e.target.value.length);
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
    let cookie = `${result.name}=${result.url}; expires=${expires.toUTCString()}; path=/; SameSite=None; Secure`;
    console.log(`Saving result in cookie: ${cookie}`);
    document.cookie = cookie;
}

function showBrowserErrorMessage() {
    // Regex: Google Chrome or Microsoft Edge
    let supportedBrowsersRegex = /Chrome|Edge/i;

    // Check Google Chrome or Microsoft Edge
    let isSupportedBrowser = supportedBrowsersRegex.test(navigator.userAgent);

    // If current browser is not Google Chrome or Microsoft Edge, Show #browser-error-message
    if (!isSupportedBrowser) {
        document.getElementById('browser-error-message').classList.remove('visually-hidden');
    }
}