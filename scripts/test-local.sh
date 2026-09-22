#!/usr/bin/env bash
# Uses disposable local PostgreSQL and Redis data; never touches the cluster.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v initdb >/dev/null && command -v brew >/dev/null; then
  if pg_prefix=$(brew --prefix postgresql@16 2>/dev/null); then
    export PATH="$pg_prefix/bin:$PATH"
  fi
fi
for cmd in node npm initdb pg_ctl createdb psql redis-server; do
  command -v "$cmd" >/dev/null || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
for service in inventory pricing storefront; do
  npm ci --prefix "pkg/$service" --no-audit --no-fund >/dev/null
done
work=$(mktemp -d)
cleanup() {
  pg_ctl -D "$work/pg" -m immediate stop >/dev/null 2>&1 || true
  if [[ -n "${redis_pid:-}" ]]; then kill "$redis_pid" 2>/dev/null || true; wait "$redis_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
initdb -D "$work/pg" -U boxoffice --auth=trust >/dev/null
pg_ctl -D "$work/pg" -l "$work/postgres.log" -o "-h 127.0.0.1 -p 15432 -k $work" -w start >/dev/null
createdb -h 127.0.0.1 -p 15432 -U boxoffice boxoffice
psql -h 127.0.0.1 -p 15432 -U boxoffice -d boxoffice -v ON_ERROR_STOP=1 -f db/schema.sql -f db/seed.sql >/dev/null
redis-server --bind 127.0.0.1 --port 16379 --save '' --appendonly no --logfile "$work/redis.log" &
redis_pid=$!
export DATABASE_URL=postgres://boxoffice@127.0.0.1:15432/boxoffice
export REDIS_URL=redis://127.0.0.1:16379
node --test --test-concurrency=1 tests/*.test.js
