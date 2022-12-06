# Use the official Python image with version 3.10
# https://hub.docker.com/_/python
FROM python:3.10-buster

# Install necessary packages
RUN apt-get update && apt-get install -y \
    curl unzip \
    ffmpeg \
    poppler \
    fonts-takao-* fonts-wqy-microhei fonts-unfonts-core

# Install Chrome
RUN wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    dpkg -i google-chrome-stable_current_amd64.deb; apt-get -fy install \
    && rm google-chrome-stable_current_amd64.deb
# Download and extract the latest version of ChromeDriver
RUN CHROME_DRIVER_VERSION=$(curl -sL "https://chromedriver.storage.googleapis.com/LATEST_RELEASE") && \
    curl -sL "https://chromedriver.storage.googleapis.com/$CHROME_DRIVER_VERSION/chromedriver_linux64.zip" > chromedriver.zip && \
    unzip chromedriver.zip -d /usr/local/bin && \
    rm chromedriver.zip


# Install Python dependencies
COPY requirements.txt requirements.txt
RUN python -m pip install --upgrade pip && pip install -r requirements.txt

# Set and move to APP_HOME
ENV APP_HOME /app
WORKDIR $APP_HOME

# Copy local code to the container image
COPY . .

# Expose the port for the app
EXPOSE 8080

# Run the web service on container startup
CMD exec uvicorn main:app --host 0.0.0.0 --port 8080
