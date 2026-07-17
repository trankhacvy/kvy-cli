#!/bin/sh
# Wraps the official nginx image's own entrypoint (which runs every script
# in /docker-entrypoint.d/, including the envsubst-on-templates step that
# renders default.conf.template) to first derive API_ORIGIN_WS from
# API_ORIGIN — so the CSP's connect-src can allowlist both the REST fetch
# scheme (http/https) and the Socket.IO WebSocket scheme (ws/wss) from one
# operator-configured value instead of two.
set -e

export API_ORIGIN="${API_ORIGIN:-http://localhost:3005}"
export API_ORIGIN_WS="$(printf '%s' "$API_ORIGIN" | sed -e 's#^http://#ws://#' -e 's#^https://#wss://#')"

exec /docker-entrypoint.sh "$@"
