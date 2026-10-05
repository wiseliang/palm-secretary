#!/usr/bin/env bash
set -euo pipefail
ARCHIVE=/tmp/palm-history-0.17.1.tar
echo "$1  $ARCHIVE" | sha256sum -c -
OLD=$(readlink -f /opt/palm-secretary/current)
NEW=/opt/palm-secretary/releases/history-0.17.1
test ! -e "$NEW"
/usr/local/bin/node <<'NODE'
const fs=require('fs');
const state=JSON.parse(fs.readFileSync('/home/codex/workspace/.palm/state.json'));
if(state.tasks.some(t=>t.status==='running'||t.submissionPending))throw new Error('存在运行中或待核对任务，停止发布');
NODE
install -d -m 0700 /root/palm-backup-history-0.17.1
cp -a /home/codex/workspace/.palm /root/palm-backup-history-0.17.1/state
cp -a /etc/nginx/conf.d/palm-secretary.conf /root/palm-backup-history-0.17.1/nginx.conf
printf '%s\n' "$OLD" > /root/palm-backup-history-0.17.1/previous-release
install -d -o codex -g codex -m 0750 "$NEW"
tar -xf "$ARCHIVE" -C "$NEW" --strip-components=1
# Dependencies are unchanged; reuse installed Linux dependencies without mutation.
ln -s "$OLD/node_modules" "$NEW/node_modules"
chown -R codex:codex "$NEW"
sudo -u codex -H env NODE_ENV=production /usr/local/bin/npm --prefix "$NEW" run build
sudo -u codex /usr/local/bin/node --experimental-strip-types "$NEW/tests/history-page.mjs"
# Check again after build, immediately before switching.
/usr/local/bin/node <<'NODE'
const fs=require('fs');const state=JSON.parse(fs.readFileSync('/home/codex/workspace/.palm/state.json'));
if(state.tasks.some(t=>t.status==='running'||t.submissionPending))throw new Error('构建期间出现新任务，停止切换');
NODE
rollback() {
  ln -sfn "$OLD" /opt/palm-secretary/current
  cp /root/palm-backup-history-0.17.1/nginx.conf /etc/nginx/conf.d/palm-secretary.conf
  systemctl restart palm-secretary-api palm-secretary-web
  nginx -t && systemctl reload nginx
}
trap rollback ERR
cp "$NEW/deploy/nginx-palm-secretary.conf" /etc/nginx/conf.d/palm-secretary.conf
nginx -t
ln -sfn "$NEW" /opt/palm-secretary/current
systemctl restart palm-secretary-api palm-secretary-web
systemctl reload nginx
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4511/api/health && curl -fsS -o /dev/null http://127.0.0.1:4510/; then
    trap - ERR
    echo 'HISTORY_RELEASE_OK'
    exit 0
  fi
  sleep 2
done
false
