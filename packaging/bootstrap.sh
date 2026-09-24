#!/usr/bin/env bash
set -euo pipefail

repo_url=https://github.com/mshykhov-space/job-hunter-automation.git
checkout_root=/usr/local/src/job-hunter-automation
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/versions.env"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run packaging/bootstrap.sh as root" >&2
  exit 1
fi

if [[ ! "${AUTOMATION_REVISION:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "AUTOMATION_REVISION must be an exact 40-character commit SHA" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git xz-utils

case "$(uname -m)" in
  x86_64)
    node_arch=x64
    node_sha256="$NODE_LINUX_X64_SHA256"
    ;;
  aarch64)
    node_arch=arm64
    node_sha256="$NODE_LINUX_ARM64_SHA256"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

if [[ "$(node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]]; then
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' EXIT
  node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}" \
    --output "$temp_dir/$node_archive"
  printf '%s  %s\n' "$node_sha256" "$temp_dir/$node_archive" | sha256sum --check --status
  tar -xJf "$temp_dir/$node_archive" -C /usr/local --strip-components=1
fi

if [[ -e "$checkout_root" && ! -d "$checkout_root/.git" ]]; then
  echo "$checkout_root exists but is not a Git checkout" >&2
  exit 1
fi

if [[ ! -d "$checkout_root/.git" ]]; then
  install -d -o root -g root -m 0755 "$(dirname "$checkout_root")"
  git clone --filter=blob:none --no-checkout "$repo_url" "$checkout_root"
elif [[ "$(git -C "$checkout_root" remote get-url origin)" != "$repo_url" ]]; then
  echo "$checkout_root has an unexpected origin" >&2
  exit 1
fi

git -C "$checkout_root" fetch --depth=1 origin "$AUTOMATION_REVISION"
git -C "$checkout_root" checkout --detach FETCH_HEAD
test "$(git -C "$checkout_root" rev-parse HEAD)" = "$AUTOMATION_REVISION"

"$checkout_root/packaging/install.sh"
