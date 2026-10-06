#!/usr/bin/env bash
# Install/refresh the Moosic web systemd unit for the current user and checkout.
#
# The unit is derived from this checkout (User, WorkingDirectory, repo path) so
# it is reproducible on any machine. The app binds loopback only; public access
# is handled by Tailscale Funnel (see ../README.md).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(id -un)"
HOME_DIR="${HOME}"
UNIT=/etc/systemd/system/moosic.service

sudo tee "${UNIT}" >/dev/null <<EOF
[Unit]
Description=Moosic web — local music library UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
Group=${USER_NAME}
WorkingDirectory=${REPO}
ExecStart=${REPO}/scripts/run.sh
Restart=on-failure
RestartSec=3
# Data repo + git push need HOME (~/.ssh, ~/.gitconfig). Mounted at /music
# behind Tailscale Funnel; also works directly at /.
Environment=HOME=${HOME_DIR}
Environment=MOOSIC_DATA=${HOME_DIR}/Projects/Music
Environment=MOOSIC_ROOT_PATH=/music

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable moosic.service
sudo systemctl restart moosic.service
echo "installed ${UNIT}"
echo "  user  : ${USER_NAME}"
echo "  repo  : ${REPO}"
echo "  status: $(systemctl is-active moosic.service)"
