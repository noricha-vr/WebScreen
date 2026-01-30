# Use the official Python image with version 3.10
# https://hub.docker.com/_/python
FROM python:3.10-bookworm

# Install necessary packages
RUN apt-get update && apt-get install -y \
    curl unzip gettext python3-babel wget \
    ffmpeg \
    poppler-utils \
    fonts-takao-* fonts-wqy-microhei fonts-unfonts-core

# Install Chrome
RUN wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    dpkg -i google-chrome-stable_current_amd64.deb; apt-get -fy install && \
    rm google-chrome-stable_current_amd64.deb

# Install ChromeDriver (Chrome for Testing API)
RUN DRIVER_URL=$(curl -s "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json" | \
        python3 -c "import sys,json; d=json.load(sys.stdin); print([x['url'] for x in d['channels']['Stable']['downloads']['chromedriver'] if 'linux64' in x['url']][0])") && \
    wget -O /tmp/chromedriver.zip "$DRIVER_URL" && \
    unzip /tmp/chromedriver.zip -d /tmp/ && \
    mv /tmp/chromedriver-linux64/chromedriver /usr/local/bin/ && \
    rm -rf /tmp/chromedriver* && \
    chmod +x /usr/local/bin/chromedriver

# Install Python dependencies
COPY requirements.txt requirements.txt
RUN python -m pip install --upgrade pip && pip install -r requirements.txt

# Set and move to APP_HOME
ENV APP_HOME /app
WORKDIR $APP_HOME
ENV PYTHONPATH $APP_HOME
# Copy local code to the container image
COPY . .

# Expose the port for the app
EXPOSE 8080

# Run the web service on container startup
CMD exec uvicorn router.main:app --host 0.0.0.0 --port 8080
