# syntax=docker/dockerfile:1.7
FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_THREAD_LIMIT=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

# Tesseract 5 (LSTM) + English and orientation data. No compilers in the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
# Same UID as the Node images (1000) so the shared storage volume works for every service.
RUN useradd --uid 1000 --create-home appuser && mkdir -p /data/storage /models && chown -R appuser:appuser /data /models /app
COPY pyproject.toml uv.lock ./

# ---- test image: includes pytest; `docker compose --profile test run --rm processor-test`
FROM base AS test
RUN uv sync --frozen --no-install-project
COPY app ./app
COPY tests ./tests
RUN chown -R appuser:appuser /app
USER appuser
ENV PATH="/app/.venv/bin:$PATH" STORAGE_DIR=/data/storage EMBEDDING_PROVIDER=hash
CMD ["pytest", "-q", "-p", "no:cacheprovider", "--junitxml=/results/processor-junit.xml"]

# ---- runtime image
FROM base AS runtime
RUN uv sync --frozen --no-dev --no-install-project
COPY app ./app
RUN chown -R appuser:appuser /app
USER appuser
ENV PATH="/app/.venv/bin:$PATH" STORAGE_DIR=/data/storage FASTEMBED_CACHE_PATH=/models
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY:-4} --timeout-keep-alive 75"]
