#!/usr/bin/env bash
set -euo pipefail
VERSION=0.17.3
ARCHIVE=/tmp/palm-direct-${VERSION}.tar
echo "$1  $ARCHIVE" | sha256sum -c -
OLD=$(readlink -f /opt/palm-secretary/current)
NEW=/opt/palm-secretary/releases/direct-${VERSION}
BACKUP=/root/palm-backup-direct-${VERSION}
test "$OLD" != "$NEW"
test ! -e /etc/systemd/system/palm-secretary-api.service.d/download-origin.conf
test -e /etc/letsencrypt/live/download.wiseliang.cloud/fullchain.pem
exec 9>/run/lock/palm-storage-cleanup.lock
flock --wait 5 9
if test ! -e "$BACKUP"; then
  install -d -m 0700 "$BACKUP"
  cp -a /home/codex/workspace/.palm "$BACKUP/state"
  cp -a /etc/palm-secretary/app.env "$BACKUP/app.env"
  cp -a /etc/nginx/conf.d/palm-download.conf "$BACKUP/nginx-download.conf"
  printf '%s\n' "$OLD" > "$BACKUP/previous-release"
fi
test "$(cat "$BACKUP/previous-release")" = "$OLD"
install -d -o codex -g codex -m 0750 "$NEW"
tar -xf "$ARCHIVE" -C "$NEW" --strip-components=1
ln -sfn "$OLD/node_modules" "$NEW/node_modules"
cp -a "$OLD/.openai" "$NEW/"
chown -R codex:codex "$NEW"
sudo -u codex -H env NODE_ENV=production /usr/local/bin/npm --prefix "$NEW" run build
(cd "$NEW"; sudo -u codex /usr/local/bin/node tests/download-ticket.mjs; sudo -u codex /usr/local/bin/node tests/direct-download.mjs)
/usr/local/bin/node <<'NODE'
const fs=require('fs');const state=JSON.parse(fs.readFileSync('/home/codex/workspace/.palm/state.json'));
if(state.tasks.some(t=>t.status==='running'||t.submissionPending))throw new Error('存在运行中或待核对任务，停止切换');
NODE
rollback() {
  ln -sfn "$OLD" /opt/palm-secretary/current
  if test -f /etc/systemd/system/palm-secretary-api.service.d/download-origin.conf; then
    mv /etc/systemd/system/palm-secretary-api.service.d/download-origin.conf "$BACKUP/disabled-download-origin.conf"
  fi
  cp "$BACKUP/nginx-download.conf" /etc/nginx/conf.d/palm-download.conf
  systemctl daemon-reload
  systemctl restart palm-secretary-api palm-secretary-web
  nginx -t && systemctl reload nginx
}
trap rollback ERR
install -m 0644 "$NEW/deploy/nginx-download.conf" /etc/nginx/conf.d/palm-download.conf
nginx -t
install -d /etc/systemd/system/palm-secretary-api.service.d
install -m 0644 "$NEW/deploy/download-origin.conf" /etc/systemd/system/palm-secretary-api.service.d/download-origin.conf
ln -sfn "$NEW" /opt/palm-secretary/current
systemctl daemon-reload
systemctl restart palm-secretary-api palm-secretary-web
systemctl reload nginx
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4511/api/health && curl -fsS -o /dev/null http://127.0.0.1:4510/; then
    test "$(curl -sS -o /dev/null -w '%{http_code}' https://download.wiseliang.cloud/api/files/direct)" = 401
    trap - ERR
    echo 'DIRECT_RELEASE_OK'
    exit 0
  fi
  sleep 2
done
false
