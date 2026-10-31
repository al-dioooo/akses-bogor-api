#!/usr/bin/env bash
# Deploy API AksesBogor di Evergarden (ADR-0026). Dijalankan sebagai user aksesbogor.
#
#   deploy.sh [ref]          deploy ref (bawaan: $DEPLOY_REF atau release) bila berbeda dari rilis aktif
#   deploy.sh --check [ref]  keluar 0 bila ref berisi commit baru, 1 bila tidak; dipakai ExecCondition
#
# Commit diekspor ke releases/<sha>, lalu di-install, di-build, dan dimigrasi sebelum tautan current dipindah.
# Restart API dilakukan akses-bogor-deploy.service, karena user aksesbogor tidak boleh me-restart service.
set -euo pipefail

root=${DEPLOY_ROOT:-/srv/akses-bogor}
repo=$root/repo.git
env_file=${ENV_FILE:-/etc/akses-bogor/api.env}
keep=3

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
# devDependencies (tsc, drizzle-kit) dibutuhkan untuk build dan migrasi.
unset NODE_ENV

check=false
if [[ ${1:-} == --check ]]; then
  check=true
  shift
fi
ref=${1:-${DEPLOY_REF:-release}}

git --git-dir="$repo" fetch --quiet --prune origin '+refs/heads/*:refs/heads/*'
sha=$(git --git-dir="$repo" rev-parse --verify "$ref^{commit}")
active=$(basename "$(readlink -f "$root/current" 2>/dev/null || echo none)")

# Mis. release yang belum pernah di-merge dari main. Dengan --check, unit dilewati, bukan gagal.
if ! git --git-dir="$repo" cat-file -e "$sha:package.json" 2>/dev/null; then
  echo "$ref ($sha) tidak berisi aplikasi; deploy dibatalkan" >&2
  exit 1
fi

if $check; then
  if [[ $sha == "$active" ]]; then
    echo "$ref masih $sha, sama dengan rilis aktif"
    exit 1
  fi
  exit 0
fi

dir=$root/releases/$sha
echo "deploy $ref ($sha)"
# Folder tanpa penanda .deploy-ok berasal dari deploy yang gagal di tengah jalan.
if [[ ! -e $dir/.deploy-ok ]]; then
  rm -rf "$dir"
  mkdir -p "$dir"
  git --git-dir="$repo" archive "$sha" | tar -x -C "$dir"
  (cd "$dir" && corepack pnpm install --frozen-lockfile && corepack pnpm build)
  touch "$dir/.deploy-ok"
fi

# Migrasi berjalan sebelum versi baru menerima trafik.
(cd "$dir" && set -a && . "$env_file" && set +a && corepack pnpm db:migrate)

ln -sfn "releases/$sha" "$root/current.new"
mv -T "$root/current.new" "$root/current"
echo "rilis aktif: $sha"

# Simpan beberapa rilis terakhir untuk rollback. touch menjadikan rilis aktif yang terbaru, juga saat
# commit lama di-deploy ulang, supaya tidak ikut terhapus.
touch "$dir"
ls -1dt "$root"/releases/*/ | tail -n +$((keep + 1)) | xargs -r rm -rf --
