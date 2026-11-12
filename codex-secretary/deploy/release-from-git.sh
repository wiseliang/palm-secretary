#!/usr/bin/env bash
# Run on the server from a clean checkout. Updates application code only.
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(id -u)" = 0
test -z "$(git status --porcelain --untracked-files=normal)"
commit=$(git rev-parse HEAD)
exec 9>/run/lock/palm-storage-cleanup.lock
flock --wait 5 9
base=/opt/palm-secretary
old=$(readlink -e "$base/current")
test -x "$old/node_modules/.bin/vinext"
test -f "$old/dist-server/index.js"
new="$base/releases/git-${commit:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$new"
install -d -m 0750 "$new"
git archive HEAD:codex-secretary | tar -x -C "$new"
mkdir -p "$new/.openai"
printf '{"d1":null,"r2":null}\n' >"$new/.openai/hosting.json"
chown -hR codex:codex "$new"
cd "$new"
run() { sudo -u codex -H "$@"; }
run /usr/local/bin/npm ci --include=dev --no-audit --no-fund
run /usr/local/bin/npm run build
run /usr/local/bin/node tests/download-ticket.mjs
run /usr/local/bin/node tests/direct-download.mjs
run /usr/local/bin/node tests/cli-update.mjs
run /usr/local/bin/node tests/cli-cleanup.mjs
run /usr/local/bin/node tests/storage-cleanup.mjs
state=/home/codex/workspace/.palm
/usr/local/bin/node -e 'const s=require(process.argv[1]); if(s.tasks.some(t=>t.status==="running"||t.submissionPending)) throw Error("????????????")' "$state/state.json"
backup="/root/palm-backup-$(basename "$new")"
install -d -m 0700 "$backup"
cp -a "$state" "$backup/state"
printf '%s\n' "$old" >"$backup/previous-release"
printf '%s\n' "$commit" >"$new/.git-revision"
sha256sum package-lock.json dist-server/index.js >"$new/.release-checksums"
switch() {
  ln -s "$1" "$base/.current-next-$$"
  mv -Tf "$base/.current-next-$$" "$base/current"
}
services=(palm-secretary-api.service palm-secretary-web.service)
rollback() { switch "$old"; systemctl restart "${services[@]}"; }
trap rollback ERR
switch "$new"
systemctl restart "${services[@]}"
for ((i=0;i<20;i++)); do
  if systemctl is-active --quiet "${services[@]}" &&
     curl -fsS --max-time 3 http://127.0.0.1:4511/api/health >/dev/null &&
     curl -fsS --max-time 3 http://127.0.0.1:4510/ >/dev/null; then
    ln -sfn "$old" "$base/rollback"
    install -o root -g root -m 0755 "$new/deploy/palm-storage-cleanup.mjs" /usr/local/libexec/palm-storage-cleanup
    trap - ERR
    printf 'Released %s\n' "$commit"
    exit 0
  fi
  sleep 2
done
false
