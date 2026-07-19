FROM python:3.12-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app ./app
COPY static ./static
EXPOSE 8000
# Bind to $PORT when a host injects one (Render/Railway/Fly); default 8000 so
# the local docker-compose (8080->8000) keeps working unchanged.
CMD ["sh","-c","uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
