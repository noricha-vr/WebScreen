# screen_capture

This project is for displaying web pages, images and desktop on the VRChat video player.

## Setup

```bash
git clone git+https://github.com/noricha-vr/screen_capture.git
cd screen_capture
docker build -t screen_capture .
docker network create my_network
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
3. Select `screen_capture` service

### VSCode settings

## Usage

1. Open the http://0.0.0.0:8080/ on your browser.
2. Enter the URL of the web page you want to display in VRChat video player.
3. Copy the URL, then paste it into the VRChat video player.
4. Enjoy!

## Useful docker commands

```bash
docker build -t screen_capture .
docker-compose up
docker exec -it screen_capture bash
docker-compose down
```