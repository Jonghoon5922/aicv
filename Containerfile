# AICV 포탈 — Podman/Docker 공용 이미지
FROM python:3.12-slim

RUN useradd -m -u 1000 app

WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server ./server
COPY static ./static

RUN mkdir -p /data && chown app:app /data
ENV DATABASE_URL=sqlite:////data/aicv.db

USER app
EXPOSE 8100
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8100"]
