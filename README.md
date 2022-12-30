# web_screen

This project is for displaying web pages, images and desktop on the VRChat video player.
Also, in the future I would like to display input images, pdfs and the user's desktop.

## Setup

```bash
git clone git+https://github.com/noricha-vr/screen_capture.git web_screen
cd web_screen
docker compose build
docker-compose up
```

When you stop the container, you can use the following command.

```bash
docker-compose down
```

or `ctrl + c`

### Pycharm settings

#### Run/Debug Configurations

- Select: FastAPI
- Path: absolute path to `main.py`
- Uvicorn options: --reload --host=0.0.0.0 --port=8080

#### Interpreter settings

1. Select `docker-compose` interpreter
2. Select `docker-compose.yaml` file
3. Select `web_screen` service

### VSCode settings

## Usage

1. Open the http://0.0.0.0:8080/ on your browser.
2. Enter the URL of the web page you want to display in VRChat video player.
3. Copy the URL, then paste it into the VRChat video player.
4. Enjoy!

## Useful docker commands

```bash
docker build -t web_screen .
docker-compose up
docker exec -it web_screen bash
docker-compose down
```

## Useful translation commands

```bash
pybabel extract -F babel.cfg -o messages.pot .
pybabel init -i messages.pot -d lang -l en
pybabel compile -d lang
```