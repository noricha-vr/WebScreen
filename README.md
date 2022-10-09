# screen_capture

## Docker commands
docker build . -t screen_capture
docker exec -it screen_capture bash
docker-compose up

## Pycharm setting
Select: FastAPI
Path: absolute path to `main.py`
Uvicorn options: --reload --host=0.0.0.0 --port=8080

