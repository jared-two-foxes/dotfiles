# python profile — Debian's python3 plus pip/venv. python-is-python3
# gives the bare `python` command the repo's own scripts and .claude
# settings expect (they invoke `python -m ...`, `python -c ...`).
# Built FROM the shared base; tagged pi-python:local by bin/pi-docker.ps1.
FROM pi-base:local
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv python-is-python3 \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m pip install --no-cache-dir --upgrade pip