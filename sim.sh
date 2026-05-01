#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 AICASTLE Inc.
#
# physicar-sim/sim.sh — Gazebo simulation install and service management
# Usage:
#   sim.sh install   — Install Gazebo Harmonic (one time)
#   sim.sh start     — Start websocket + sim_api (every boot)
#   sim.sh watchdog  — Restart dead services (called from watchdog loop)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARE_DIR="$SCRIPT_DIR/share"

# When running as root (systemd) -> switch to physicar user; otherwise stay as current user
if [ "$(id -u)" = "0" ]; then
  _GZ_USER="${GZ_USER:-physicar}"
  _as_user() { runuser -u "$_GZ_USER" -- "$@"; }
else
  _GZ_USER="$(whoami)"
  _as_user() { "$@"; }
fi
_GZ_HOME="$(eval echo "~$_GZ_USER")"

# ──────────────────────────────────────────────────────────────
# install: Gazebo Harmonic + sudoers
# ──────────────────────────────────────────────────────────────
do_install() {
  echo "[physicar-sim] Installing Gazebo Harmonic..."

  # Gazebo apt repo
  curl -fsSL https://packages.osrfoundation.org/gazebo.gpg \
    -o /usr/share/keyrings/pkgs-osrf-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/pkgs-osrf-archive-keyring.gpg] https://packages.osrfoundation.org/gazebo/ubuntu-stable $(lsb_release -cs) main" \
    | sudo tee /etc/apt/sources.list.d/gazebo-stable.list > /dev/null
  sudo apt-get update -y
  sudo apt-get install -y gz-harmonic ros-jazzy-ros-gz

  # Deploy sample nginx config (only when no existing config)
  if [ ! -f /etc/nginx/sites-available/gazebo ] && [ -f "$SCRIPT_DIR/nginx.conf.example" ]; then
    sed "s|__SHARE_DIR__|$SHARE_DIR|g" "$SCRIPT_DIR/nginx.conf.example"       > /etc/nginx/sites-available/gazebo
    ln -sf /etc/nginx/sites-available/gazebo /etc/nginx/sites-enabled/
    nginx -t 2>/dev/null && nginx -s reload 2>/dev/null || true
    echo "[physicar-sim] nginx config installed (port 8080)"
  fi

  # Allow nginx to access the physicar-sim directory
  usermod -aG physicar www-data 2>/dev/null || true

  echo "[physicar-sim] Install complete"
}

# ──────────────────────────────────────────────────────────────
# start: Start services on boot (git pull + websocket + sim_api)
# ──────────────────────────────────────────────────────────────
do_start() {
  if [ -f "$SCRIPT_DIR/websocket.gzlaunch" ]; then
    _as_user env GZ_CONFIG_PATH=/usr/share/gz GZ_PARTITION=physicar \
      gz launch "$SCRIPT_DIR/websocket.gzlaunch" &>/dev/null &
    echo "[physicar-sim] WebSocket server started (port 9002)"
  fi

  if [ -f "$SCRIPT_DIR/sim_api.py" ]; then
    _as_user python3 "$SCRIPT_DIR/sim_api.py" &>/dev/null &
    echo "[physicar-sim] Sim API started (port 9003)"
  fi
}

# ──────────────────────────────────────────────────────────────
# watchdog: Called from watchdog loop (restart dead services)
# ──────────────────────────────────────────────────────────────
do_watchdog() {
  if ! ss -tlnp 2>/dev/null | grep -q ':9002 '; then
    if [ -f "$SCRIPT_DIR/websocket.gzlaunch" ]; then
      _as_user env GZ_CONFIG_PATH=/usr/share/gz GZ_PARTITION=physicar \
        gz launch "$SCRIPT_DIR/websocket.gzlaunch" &>/dev/null &
    fi
  fi
  if ! ss -tlnp 2>/dev/null | grep -q ':9003 '; then
    if [ -f "$SCRIPT_DIR/sim_api.py" ]; then
      _as_user python3 "$SCRIPT_DIR/sim_api.py" &>/dev/null &
    fi
  fi
}


# ──────────────────────────────────────────────────────────────
case "${1:-}" in
  install)  do_install ;;
  start)    do_start ;;
  watchdog) do_watchdog ;;
  *)
    echo "Usage: $0 {install|start|watchdog}"
    exit 1
    ;;
esac
