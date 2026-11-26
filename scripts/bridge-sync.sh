#!/usr/bin/env bash
# ==============================================================================
# Sentra Linux Bridge VPS — Automated Sing-box Config Sync Script
# ==============================================================================
# Fetches compiled sing-box 1.14+ bridge config from Cloudflare Worker
# (`GET /api/v1/bridge/config`), validates JSON + sing-box syntax, compares
# SHA-256 hash against `/etc/sing-box/config.json`, and restarts `sing-box`
# ONLY when the configuration has changed.
#
# Recommended Cron entry (runs every 5 minutes):
#   */5 * * * * SENTRA_WORKER_URL="https://your-worker.workers.dev" \
#     BRIDGE_SECRET_KEY="your-secret" /usr/local/bin/bridge-sync.sh \
#     >> /var/log/sentra-bridge-sync.log 2>&1
# ==============================================================================

set -euo pipefail
umask 077

SENTRA_WORKER_URL="${SENTRA_WORKER_URL:-}"
BRIDGE_SECRET_KEY="${BRIDGE_SECRET_KEY:-}"
CONFIG_PATH="${SINGBOX_CONFIG_PATH:-/etc/sing-box/config.json}"
SINGBOX_SERVICE="${SINGBOX_SERVICE_NAME:-sing-box}"
CURL_TIMEOUT="${CURL_TIMEOUT:-15}"

if [[ -z "${SENTRA_WORKER_URL}" || -z "${BRIDGE_SECRET_KEY}" ]]; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] ERROR: SENTRA_WORKER_URL and BRIDGE_SECRET_KEY must be set." >&2
  exit 1
fi

ENDPOINT="${SENTRA_WORKER_URL%/}/api/v1/bridge/config"
TMP_FILE="$(mktemp /tmp/sentra-bridge-config.XXXXXX.json)"
cleanup() {
  rm -f "${TMP_FILE}"
}
trap cleanup EXIT

HTTP_CODE="$(
  curl -sS -L \
    --max-time "${CURL_TIMEOUT}" \
    -H "Authorization: Bearer ${BRIDGE_SECRET_KEY}" \
    -H "Accept: application/json" \
    -w "%{http_code}" \
    -o "${TMP_FILE}" \
    "${ENDPOINT}"
)"

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] ERROR: Bridge config fetch failed with HTTP ${HTTP_CODE}." >&2
  exit 1
fi

# Validate well-formed JSON before touching production config
if command -v jq >/dev/null 2>&1; then
  jq empty "${TMP_FILE}"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m json.tool "${TMP_FILE}" >/dev/null
else
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] WARN: Neither jq nor python3 found; skipping JSON syntax check." >&2
fi

# Validate against sing-box schema if sing-box binary is installed
if command -v sing-box >/dev/null 2>&1; then
  if ! sing-box check -c "${TMP_FILE}" >/dev/null 2>&1; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] ERROR: Downloaded config failed 'sing-box check'. Aborting swap." >&2
    exit 1
  fi
fi

NEW_HASH="$(sha256sum "${TMP_FILE}" | awk '{print $1}')"
OLD_HASH=""
if [[ -f "${CONFIG_PATH}" ]]; then
  OLD_HASH="$(sha256sum "${CONFIG_PATH}" | awk '{print $1}')"
fi

if [[ "${NEW_HASH}" == "${OLD_HASH}" ]]; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] No config change detected (sha256=${NEW_HASH:0:12}...). Skipping restart."
  exit 0
fi

mkdir -p "$(dirname "${CONFIG_PATH}")"
install -m 0640 "${TMP_FILE}" "${CONFIG_PATH}.new"
mv -f "${CONFIG_PATH}.new" "${CONFIG_PATH}"

if command -v systemctl >/dev/null 2>&1; then
  systemctl restart "${SINGBOX_SERVICE}"
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Updated ${CONFIG_PATH} (sha256=${NEW_HASH:0:12}...) and restarted ${SINGBOX_SERVICE}."
else
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Updated ${CONFIG_PATH} (sha256=${NEW_HASH:0:12}...). Restart sing-box manually (systemctl not found)."
fi
