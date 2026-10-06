# syntax=docker/dockerfile:1

##############################################################################
# band-worker-desktop image (plan step 7.1)
#
# The worker image plus a virtual desktop: Xvfb, fluxbox, x11vnc, Chromium and
# the libraries GUI apps usually need. The entrypoint starts the display and
# x11vnc (127.0.0.1 only, no password), exports DISPLAY, then runs band-worker.
# The worker reports the `desktop` capability and serves the RFB stream to the
# hub over its link, so no VNC port is published.
#
#   docker build -f docker/worker.Dockerfile -t band-worker .
#   docker build -f docker/worker-desktop.Dockerfile -t band-worker-desktop .
#   docker run -d -v band-work:/work \
#     -e BAND_HUB_URL=https://hub.example.com \
#     -e BAND_WORKER_TOKEN=bwb_... band-worker-desktop
#
# BAND_DESKTOP_RESOLUTION (default 1280x800x24) sets the screen size.
##############################################################################

ARG BASE_IMAGE=band-worker
FROM ${BASE_IMAGE}

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb fluxbox x11vnc x11-utils xauth \
      chromium fonts-liberation fonts-noto-color-emoji \
      libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 \
 && rm -rf /var/lib/apt/lists/*

COPY docker/desktop-entrypoint.sh /usr/local/bin/band-desktop-entrypoint
RUN chmod 755 /usr/local/bin/band-desktop-entrypoint

# Same non-root user as the worker image. Xvfb's socket directory is under /tmp, which the docker
# runner hook mounts as a tmpfs.
USER worker
ENV DISPLAY=:99 \
    BAND_DESKTOP_RESOLUTION=1280x800x24

ENTRYPOINT ["band-desktop-entrypoint"]
