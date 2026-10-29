#!/bin/zsh
# Start DeepSeek Harness with an auto-discovered browser debugging port.
#
# Usage:
#   dsh-native-browser.sh            focus an already-connected app, or start a stopped one
#   dsh-native-browser.sh --restart  relaunch a running app that has no debugging port
#   dsh-native-browser.sh --prompt   ask before relaunching a running app without a debugging port
set -euo pipefail

BUNDLE_ID="com.deepseek.dsh"
APP_BUNDLE="$(mdfind "kMDItemCFBundleIdentifier == '$BUNDLE_ID'" 2>/dev/null | head -1)"
if [[ -z "$APP_BUNDLE" || ! -d "$APP_BUNDLE" ]]; then
  APP_BUNDLE="$(osascript -e "POSIX path of (path to application id \"$BUNDLE_ID\")" 2>/dev/null || true)"
fi
if [[ -z "$APP_BUNDLE" || ! -d "$APP_BUNDLE" ]]; then
  echo "cannot locate the DeepSeek Harness app bundle ($BUNDLE_ID)" >&2
  exit 1
fi
EXEC_NAME="$(defaults read "$APP_BUNDLE/Contents/Info.plist" CFBundleExecutable 2>/dev/null || true)"
BIN="$APP_BUNDLE/Contents/MacOS/${EXEC_NAME:-$(basename "$APP_BUNDLE" .app)}"
APP_NAME="$(basename "$APP_BUNDLE" .app)"
LOG="${DSH_HOME:-$HOME/.dsh}/browser-cdp-restart.log"
FORCE=0
PROMPT=0
case "${1:-}" in
  --restart) FORCE=1 ;;
  --prompt) PROMPT=1 ;;
esac

port_file() {
  local candidate
  for candidate in \
    "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop/DevToolsActivePort" \
    "$HOME/Library/Application Support/dsh-desktop/DevToolsActivePort"; do
    if [[ -f "$candidate" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done
  return 1
}
running() { pgrep -f "$BIN" >/dev/null 2>&1; }
port() {
  local file
  file="$(port_file)" || return 0
  head -1 "$file" | tr -d '[:space:]'
}
cdp_up() {
  local p
  p="$(port)"
  [[ -n "$p" ]] && curl -sf --max-time 1 "http://127.0.0.1:$p/json/version" >/dev/null 2>&1
}

if running && cdp_up; then
  open -a "$APP_NAME" >/dev/null 2>&1 || true
  echo "already running with CDP on port $(port)"
  exit 0
fi

if running; then
  if [[ $FORCE -eq 0 ]]; then
    if [[ $PROMPT -eq 1 ]]; then
      if osascript -e 'display dialog "当前启动未开启浏览器调试（CDP），插件无法控制侧栏浏览器。是否重启 DeepSeek Harness 以开启？会话记录会保留。" buttons {"Cancel", "OK"} default button "Cancel" with icon caution' >/dev/null 2>&1; then
        FORCE=1
      else
        exit 0
      fi
    else
      echo "DeepSeek Harness is running without CDP." >&2
      echo "Re-run with --restart to relaunch it (the session history is preserved)." >&2
      exit 2
    fi
  fi
  osascript -e 'quit app "DeepSeek Harness"' >/dev/null 2>&1 || true
  for _ in {1..80}; do
    running || break
    sleep 0.25
  done
  if running; then
    echo "The app did not quit (it may be showing a confirmation dialog)." >&2
    exit 3
  fi
fi

# Let LaunchServices release the quit registration before starting a new instance.
sleep 1
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
echo "[$(date -u +%FT%TZ)] manual restart requested" >>"$LOG"
STALE="$(port_file 2>/dev/null || true)"
if [[ -n "$STALE" ]]; then rm -f "$STALE"; fi

# The Host may export ELECTRON_RUN_AS_NODE; the app must not inherit it.
unset ELECTRON_RUN_AS_NODE
nohup "$BIN" --remote-debugging-port=0 >>"$LOG" 2>&1 &
APP_PID=$!
for _ in {1..120}; do
  if cdp_up; then
    open -a "$APP_NAME" >/dev/null 2>&1 || true
    echo "CDP ready on port $(port)"
    exit 0
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "The launched app exited early; trying open -n" >&2
    break
  fi
  sleep 0.25
done

open -n -a "$APP_NAME" --args --remote-debugging-port=0
for _ in {1..80}; do
  if cdp_up; then
    echo "CDP ready on port $(port) (fallback)"
    exit 0
  fi
  sleep 0.25
done

echo "The app did not expose a CDP port within 30s; see $LOG" >&2
exit 4
