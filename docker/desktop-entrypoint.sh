#!/bin/sh
# Starts a virtual desktop, then the band-worker (plan step 7.1). Run by the band-worker-desktop image and
# by the docker runner hook with `desktop: true`.
#
#   Xvfb :99             the display, at BAND_DESKTOP_RESOLUTION (default 1280x800x24)
#   fluxbox              a light window manager, so GUI apps get decorations and focus
#   x11vnc               the VNC server, bound to 127.0.0.1 only, with no password
#
# x11vnc has no password and no other listener on purpose: the only way to it is the worker's link
# (`desktop.open`), and the hub authenticates the viewer. Never remove -localhost.
#
# DISPLAY is exported before the worker starts, so every agent, terminal and Playwright headed run the
# worker launches draws on this display.
set -eu

display="${BAND_DESKTOP_DISPLAY:-:99}"
resolution="${BAND_DESKTOP_RESOLUTION:-1280x800x24}"
port="${BAND_DESKTOP_VNC_PORT:-5900}"

case "$display" in :[0-9]*) ;; *) echo "BAND_DESKTOP_DISPLAY must look like :99 (got $display)" >&2; exit 1 ;; esac
case "$resolution" in [0-9]*x[0-9]*x[0-9]*) ;; *) echo "BAND_DESKTOP_RESOLUTION must look like 1280x800x24 (got $resolution)" >&2; exit 1 ;; esac

mkdir -p "${HOME:-/tmp}" 2>/dev/null || true

Xvfb "$display" -screen 0 "$resolution" -nolisten tcp >/tmp/xvfb.log 2>&1 &
export DISPLAY="$display"

# Wait for the display, up to 10 seconds.
n=0
until xdpyinfo -display "$display" >/dev/null 2>&1; do
  n=$((n + 1))
  if [ "$n" -gt 100 ]; then
    echo "Xvfb did not start on $display" >&2
    cat /tmp/xvfb.log >&2 || true
    exit 1
  fi
  sleep 0.1
done

fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display "$display" -localhost -rfbport "$port" -nopw -forever -shared -noxdamage -quiet \
  >/tmp/x11vnc.log 2>&1 &

# Wait for x11vnc to listen (the worker reports the desktop as soon as it starts, and a viewer may
# be waiting), up to 10 seconds. A failure is logged and the worker starts anyway: `desktop.open`
# then fails with the connect error.
n=0
until node -e 'require("net").connect({host:"127.0.0.1",port:Number(process.argv[1])}).on("connect",function(){this.destroy()}).on("error",()=>process.exit(1))' "$port" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 50 ]; then
    echo "x11vnc is not listening on 127.0.0.1:$port" >&2
    cat /tmp/x11vnc.log >&2 || true
    break
  fi
  sleep 0.2
done

exec band-worker "$@"
