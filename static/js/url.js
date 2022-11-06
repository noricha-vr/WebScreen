'use static';

window.onload = function () {
    // when click submit button, create movie
    submitButton.addEventListener('click', submit);
    // when click copy button, copy movie_url to clipboard
    copyButton.addEventListener('click', () => {
        copyToClipboard();
    })
}
