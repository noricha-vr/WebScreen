const CREATE_MOVIE_URL = '/api/create_movie/';

function createMovie(movie) {
    let request_url = `${CREATE_MOVIE_URL}?url=${movie.url}&max_page_height=${movie.max_page_height}` +
        `&width=${movie.width}&height=${movie.height}`;
    console.log(`Requesting ${request_url}`);
    return fetch(request_url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    });
}


// when click submit button, create movie
document.getElementById('submit').addEventListener('click', async () => {
    console.log('submit');
    // invisible submit button. add  visually-hidden class
    document.getElementById('submit').className = 'visually-hidden';
    // visible loading button. remove visually-hidden class
    document.getElementById('loading').className = '';
    let movie = {
        url: encodeURI(document.getElementById('url').value),
        max_page_height: document.getElementById('max_page_height').value,
        width: document.getElementById('width').value,
        height: document.getElementById('height').value,
    }
    console.log(`movie: ${JSON.stringify(movie)}`);
    createMovie(movie).then((response) => {
        console.log(`response: ${JSON.stringify(response)}`);
        // show submit button
        document.getElementById('submit').className = 'btn btn-primary';
        // hide loading button
        document.getElementById('loading').className = 'visually-hidden';
        if (response.status === 200) {
            // set url to movie_url
            response.json().then((data) => {
                console.log(`data: ${JSON.stringify(data)}`);
                // set movie_url
                document.getElementById('movie_url').href = data.url;
                document.getElementById('movie_url').innerHTML = data.url;
                // show movie_url
                document.getElementById('result').className = '';
            });
        } else {
            alert('error');
        }
    });
});

function copyToClipboard() {
    let copyText = document.getElementById("movie_url").href;
    navigator.clipboard.writeText(copyText).then(r => {
        console.log('copied');
        document.getElementById('copy').innerHTML = 'Copied!';
    });
}

// when click copy button, copy movie_url to clipboard
document.getElementById('copy').addEventListener('click', () => {
    copyToClipboard();
})