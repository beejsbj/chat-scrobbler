FROM ubuntu:24.04

# Match the existing venv's /usr/bin/python3.12 symlink and native ABI.
# No pip installs, model fetches, or dependency copies from the host.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3.12 ffmpeg coreutils libstdc++6 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/embedder/ /app/services/embedder/
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

ENTRYPOINT ["nice", "-n", "19"]
CMD ["/mnt/server-ssd/spikes/bjs-544/venv-a/bin/python", "-m", "services.embedder"]
