# screen_capture

## Setup

1. Replace screen_capture with your project name at cloudbuild.yml and docker-compose.yml, README.md.
1. Build docker file. Use Docker commands. 

## Docker commands
docker build . -t screen_capture
docker exec -it screen_capture bash
docker-compose up

## Pycharm setting
Select: FastAPI
Path: absolute path to `main.py`
Uvicorn options: --reload --host=0.0.0.0 --port=8080

