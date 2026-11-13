FROM python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg coreutils libstdc++6 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/embedder/requirements.txt /app/services/embedder/requirements.txt
RUN pip install --no-cache-dir -r services/embedder/requirements.txt
COPY services/embedder/ /app/services/embedder/
# Fetch the immutable revision at build time and verify its SHA-256. No runtime fetch.
RUN python -m services.embedder.fetch_model
# Run as the user that owns the asset blobs (0600, written by the scrobbler image).
# Compose passes the same DATA_UID/DATA_GID to both images; keep 999 as the default.
ARG DATA_UID=999
ARG DATA_GID=999
RUN mkdir -p /var/cache/embedder \
    && chown "${DATA_UID}:${DATA_GID}" /var/cache/embedder
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2 \
    HOME=/var/cache/embedder \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

USER ${DATA_UID}:${DATA_GID}
ENTRYPOINT ["nice", "-n", "19"]
CMD ["python", "-m", "services.embedder"]
