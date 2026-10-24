#!/bin/sh
set -eu

REPOSITORY="TorranceZHANG/TorranceTabs"
VERSION=""
DRY_RUN=0
TEST_MODE=0
TEST_ROOT=""

usage() {
  echo "用法: uninstall.sh [--version 1.5.0] [--dry-run]" >&2
}

valid_version() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
}

curl_fetch() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 10 --max-time 120 --retry 3 --retry-delay 1 -fsSL "$@"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || { usage; exit 2; }; VERSION=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --test-mode) TEST_MODE=1; shift ;;
    --test-root) [ "$#" -ge 2 ] || { usage; exit 2; }; TEST_ROOT=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [ -n "$VERSION" ] && ! valid_version "$VERSION"; then
  echo "错误：版本必须是数字格式，例如 1.5.0。" >&2
  exit 2
fi
if [ "$TEST_MODE" -eq 1 ] && [ -z "$TEST_ROOT" ]; then
  echo "错误：--test-mode 必须提供 --test-root。" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "错误：需要 Python 3.6 或更高版本。" >&2
  exit 1
fi

case "$0" in
  */*) SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) ;;
  *) SCRIPT_DIR="" ;;
esac
LOCAL_MANAGER=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/scripts/manage.py" ]; then
  LOCAL_MANAGER="$SCRIPT_DIR/scripts/manage.py"
fi

TEMP_DIR=""
cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)' "$TEMP_DIR"
  fi
}
trap cleanup EXIT HUP INT TERM

if [ -n "$LOCAL_MANAGER" ]; then
  MANAGER=$LOCAL_MANAGER
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "错误：需要 curl 下载固定 release 的卸载管理器。" >&2
    exit 1
  fi
  if [ -z "$VERSION" ]; then
    LATEST_URL=$(curl_fetch -o /dev/null -w '%{url_effective}' "https://github.com/$REPOSITORY/releases/latest") || {
      echo "错误：无法解析最新 release。" >&2
      exit 1
    }
    TAG=${LATEST_URL##*/}
    case "$TAG" in
      v*) VERSION=${TAG#v} ;;
      *) echo "错误：最新 release 标签不是 v数字版本。" >&2; exit 1 ;;
    esac
  fi
  if ! valid_version "$VERSION"; then
    echo "错误：release 标签不是 v数字版本。" >&2
    exit 1
  fi
  TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/torrance-tabs.XXXXXX")
  MANAGER="$TEMP_DIR/manage.py"
  curl_fetch "https://raw.githubusercontent.com/$REPOSITORY/v$VERSION/scripts/manage.py" -o "$MANAGER" || {
    echo "错误：无法下载 v$VERSION 卸载管理器；不会回退到 main。" >&2
    exit 1
  }
fi

set -- uninstall
if [ "$DRY_RUN" -eq 1 ]; then set -- "$@" --dry-run; fi
if [ "$TEST_MODE" -eq 1 ]; then set -- "$@" --test-mode --test-root "$TEST_ROOT"; fi
python3 "$MANAGER" "$@"
