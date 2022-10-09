# Solonium

## Setup

1. Replace solonium with your project name at cloudbuild.yml and docker-compose.yml, README.md.
1. Build docker file. Use Docker commands. 

## Docker commands
docker build . -t solonium
docker exec -it solonium bash
docker-compose up

## Pycharm setting
Select: FastAPI
Path: absolute path to `main.py`
Uvicorn options: --reload --host=0.0.0.0 --port=8080

