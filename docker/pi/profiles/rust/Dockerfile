# rust profile — adds rustup + stable toolchain (default profile, so
# rustfmt/clippy are present; the ticket-pipeline gates run both).
# Built FROM the shared base; tagged pi-rust:local by bin/pi-docker.ps1.
FROM pi-base:local

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       curl ca-certificates build-essential pkg-config \
  && rm -rf /var/lib/apt/lists/* \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
     | sh -s -- -y --profile default --component rustfmt,clippy

# Pinned so an optional future cache volume can mount them at known paths.
ENV CARGO_HOME=/root/.cargo \
    RUSTUP_HOME=/root/.rustup \
    PATH="/root/.cargo/bin:${PATH}"