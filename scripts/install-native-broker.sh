#!/usr/bin/env bash
# Install or refresh the Spriite native broker on your Factory host: the Linux
# or macOS machine where Factory's `droid` is installed and signed in. The
# broker runs as a per-user service (systemd --user on Linux, a LaunchAgent on
# macOS), listens on loopback only, and runs Factory Missions in owner-trusted
# host mode. Windows is not supported.
#
#   scripts/install-native-broker.sh              install or refresh
#   scripts/install-native-broker.sh --dry-run    print the plan, change nothing
#   --non-interactive   never prompt (what `spriite pair` runs)
#   --summary           end with one SPRIITE_INSTALL_SUMMARY {json} line (no secrets)
#
# `npx spriite pair` runs this for you on a first install and reuses an
# existing install (and its broker.env) after that.
#
# Inputs (environment):
#   MODELS            required on first install: JSON array of Factory model ids
#                     the broker may run, e.g. MODELS='["<model-id>"]'
#   FACTORY_API_KEY   your Factory API key, or
#   FACTORY_KEY_FILE  a file holding it (bare key, or a FACTORY_API_KEY=... line).
#                     Optional on refresh when a key file is already installed.
#   OWNER             broker owner id (default: owner-<your login name>)
#   DROID             droid executable (default: PATH, ~/.local/bin, Factory.app)
#   GH, GIT, NODE     executables (default: PATH)
#   TOOLS             JSON array of allowed droid tool ids (default below)
#   ORIGINS           comma-separated exact browser origins allowed by CORS, or
#                     '*' (default) for any origin; the bearer token still gates
#                     every request
#   PORT              loopback port (default 47821)
#   SERVE_PORT        HTTPS port for `tailscale serve` (default 47822)
#   EXPOSE            auto (default) | tailscale | none
#   SPRIITE_HOME      base dir (default: $XDG_DATA_HOME/spriite/native-broker on
#                     Linux, ~/Library/Application Support/Spriite/native-broker
#                     on macOS)
#   SPRIITE_INSTALL_OS  linux | macos, overrides `uname` (used by tests)
#
# The Factory API key is never printed. It is written to a 0600 file the broker
# reads at start.
set -euo pipefail

DRY_RUN=0 NONINTERACTIVE="${SPRIITE_INSTALL_NONINTERACTIVE:-0}" SUMMARY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --non-interactive) NONINTERACTIVE=1 ;;
    --summary) SUMMARY=1 ;;
    -h|--help) sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$REPO/broker/server.mjs" ] || die "broker/ not found next to this script ($REPO/broker)"

# ---- platform ---------------------------------------------------------------
OS="${SPRIITE_INSTALL_OS:-}"
if [ -z "$OS" ]; then
  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=macos ;;
    *) OS=unsupported ;;
  esac
fi
case "$OS" in
  linux|macos) ;;
  *) die "unsupported OS '$OS'. The native broker runs on Linux or macOS; Windows is not supported." ;;
esac

if [ -n "${SPRIITE_HOME:-}" ]; then
  B="$SPRIITE_HOME"
elif [ "$OS" = linux ]; then
  B="${XDG_DATA_HOME:-$HOME/.local/share}/spriite/native-broker"
else
  B="$HOME/Library/Application Support/Spriite/native-broker"
fi
case "$B" in /*) ;; *) die "SPRIITE_HOME must be an absolute path" ;; esac
case "$B/" in */./*|*/../*) die "SPRIITE_HOME must not contain . or .. components" ;; esac

# Physical form of an absolute path: repeated and trailing slashes removed and
# the existing part resolved through symlinks (pwd -P), the missing tail kept.
# The broker compares realpath(path) === path for its store, keys and secrets,
# so broker.env must hold canonical paths.
canonical_path() {
  local p head tail=""
  p="$(printf '%s' "$1" | tr -s '/')"
  [ "$p" = / ] || p="${p%/}"
  head="$p"
  while [ ! -d "$head" ]; do
    tail="/$(basename "$head")$tail"
    head="$(dirname "$head")"
  done
  head="$(cd "$head" && pwd -P)"
  [ "$head" = / ] && head=""
  printf '%s%s\n' "$head" "$tail"
}
B="$(canonical_path "$B")"
APP="$B/app" HOSTROOT="$B/host" SECRETS="$B/secrets" STORE="$B/store" LOGS="$B/logs"
ENV_FILE="$B/broker.env" RUN="$B/run.sh" TOKEN_FILE="$B/bearer-token"
KEY_OUT="$SECRETS/factory-api-key" EXT_OUT="$SECRETS/extension-token"

LABEL=ai.spriite.native-broker
UNIT=spriite-native-broker.service
if [ "$OS" = linux ]; then
  SERVICE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
else
  SERVICE_FILE="$HOME/Library/LaunchAgents/$LABEL.plist"
fi

# Reads a single-quoted value written by a previous install, if any.
previous() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^export $1='\\(.*\\)'\$/\\1/p" "$ENV_FILE" | tail -n 1
}

# ---- executables ------------------------------------------------------------
absolute_exe() { # candidate...
  local c
  for c in "$@"; do
    [ -n "$c" ] || continue
    case "$c" in /*) ;; *) c="$(command -v "$c" 2>/dev/null || true)" ;; esac
    if [ -n "$c" ] && [ -f "$c" ] && [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}

NODE="$(absolute_exe "${NODE:-}" node)" || die "Node.js 22.18+ is required (node not found on PATH; or set NODE=/path/to/node)"
# The broker imports a .ts module, which needs Node's default type stripping:
# Node 22.18+, 23.6+ or 24+.
"$NODE" -e '
const [major, minor] = process.versions.node.split(".").map(Number)
process.exit(major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18) ? 0 : 1)' \
  || die "Node.js 22.18 or newer is required ($NODE is $("$NODE" --version)). Install a current Node 22 LTS or later (for example with nvm, fnm or NodeSource), or set NODE=/path/to/node."

droid_candidates=("${DROID:-}" droid "$HOME/.local/bin/droid")
if [ "$OS" = macos ]; then
  droid_candidates+=("/Applications/Factory.app/Contents/Resources/bin/droid"
    "$HOME/Applications/Factory.app/Contents/Resources/bin/droid")
fi
DROID_BIN="$(absolute_exe "${droid_candidates[@]}")" \
  || die "droid not found. Install Factory's droid CLI on this host (or set DROID=/path/to/droid), run it once and sign in."
GIT_BIN="$(absolute_exe "${GIT:-}" git)" || die "git not found on PATH (or set GIT=/path/to/git)"
GH_BIN="$(absolute_exe "${GH:-}" gh)" \
  || die "GitHub CLI (gh) not found on PATH (or set GH=/path/to/gh). The broker uses it to push and open PRs; run 'gh auth login' if deliveries will push."

# The broker refuses executables other accounts could replace. Name the exact
# file and the fix here rather than failing later inside the deployment digest.
# A file you own that only your own primary group can write (droid installed
# under umask 002) is accepted, as the broker accepts it.
"$NODE" -e '
const fs = require("fs")
let bad = 0
for (const path of process.argv.slice(1)) {
  let real, st
  try { real = fs.realpathSync(path); st = fs.statSync(real) } catch { console.error(`error: ${path} is missing`); bad = 1; continue }
  const own = st.uid === process.getuid() && st.gid === process.getgid()
  if ((st.mode & 0o002) || ((st.mode & 0o020) && !own)) {
    console.error(`error: ${real} is writable by other users (mode ${(st.mode & 0o777).toString(8)}). Fix it with:  chmod go-w ${JSON.stringify(real)}`)
    bad = 1
  }
}
process.exit(bad)' "$DROID_BIN" "$GH_BIN" "$GIT_BIN" \
  || die "fix the permissions above (or point DROID, GH or GIT at another copy) and rerun"

# ---- identity ---------------------------------------------------------------
COMPUTER_JSON="$HOME/.factory/computer.json"
[ -f "$COMPUTER_JSON" ] || die "$COMPUTER_JSON not found: run droid once and sign in first (it registers this machine)."
MACHINE="$("$NODE" -e '
const id = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).computerId
if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) process.exit(1)
process.stdout.write(id)' "$COMPUTER_JSON")" \
  || die "$COMPUTER_JSON has no usable computerId: run droid once and sign in first."

if [ -n "${OWNER:-}" ]; then
  OWNER_ID="$OWNER"
elif [ -n "$(previous SPRIITE_NATIVE_OWNER_ID)" ]; then
  OWNER_ID="$(previous SPRIITE_NATIVE_OWNER_ID)"
else
  login="$(id -un | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')"
  OWNER_ID="owner-${login:-local}"
fi
printf '%s' "$OWNER_ID" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' \
  || die "OWNER '$OWNER_ID' must start with a letter or digit and use only A-Z a-z 0-9 . _ : -"

# ---- configuration ----------------------------------------------------------
DEFAULT_TOOLS='["Read","LS","Glob","Grep","Execute","Create","Edit","ApplyPatch","TodoWrite","Script","Task","SpawnAgent","SendMessage","ListAgents","InterruptAgent"]'
MODELS_JSON="${MODELS:-$(previous SPRIITE_NATIVE_ALLOWED_MODEL_IDS)}"
TOOLS_JSON="${TOOLS:-$(previous SPRIITE_NATIVE_ALLOWED_TOOL_IDS)}"
TOOLS_JSON="${TOOLS_JSON:-$DEFAULT_TOOLS}"
ORIGINS_LIST="${ORIGINS:-$(previous SPRIITE_NATIVE_ALLOWED_ORIGINS)}"
# The Even app's WebView origin is decided by the glasses host (it may be the
# opaque "null"), so the default allows any origin. CORS is not the auth gate:
# every broker request needs the bearer token. Set ORIGINS to restrict it.
ORIGINS_LIST="${ORIGINS_LIST:-*}"
PORT="${PORT:-47821}" SERVE_PORT="${SERVE_PORT:-47822}" EXPOSE="${EXPOSE:-auto}"

[ -n "$MODELS_JSON" ] || die "MODELS is required: a JSON array of the Factory model ids this broker may run, e.g.
  MODELS='[\"<model-id>\"]' $0
Use model ids your Factory account can select in droid (the /model picker). The model in your
phone's X template and Mission settings must be one of them. There is no default on purpose."
json_list_ok() {
  "$NODE" -e '
let v; try { v = JSON.parse(process.argv[1]) } catch { process.exit(1) }
process.exit(Array.isArray(v) && v.length > 0 && v.every(s => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\/@-]*$/.test(s)) ? 0 : 1)' "$1"
}
json_list_ok "$MODELS_JSON" || die "MODELS must be a nonempty JSON array of model id strings, e.g. MODELS='[\"<model-id>\"]'"
json_list_ok "$TOOLS_JSON" || die "TOOLS must be a nonempty JSON array of droid tool id strings"
case "$PORT" in ''|*[!0-9]*) die "PORT must be a number" ;; esac
case "$SERVE_PORT" in ''|*[!0-9]*) die "SERVE_PORT must be a number" ;; esac
case "$ORIGINS_LIST" in *"'"*|*' '*) die "ORIGINS must be comma-separated origins (or '*') without spaces or quotes" ;; esac
case "$EXPOSE" in auto|tailscale|none) ;; *) die "EXPOSE must be auto, tailscale or none" ;; esac

# ---- Factory API key (never printed) ----------------------------------------
KEY=""
KEY_SOURCE=""
if [ -n "${FACTORY_API_KEY:-}" ]; then
  KEY="$FACTORY_API_KEY" KEY_SOURCE="FACTORY_API_KEY"
elif [ -n "${FACTORY_KEY_FILE:-}" ]; then
  [ -r "$FACTORY_KEY_FILE" ] || die "FACTORY_KEY_FILE is not readable: $FACTORY_KEY_FILE"
  KEY="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}FACTORY_API_KEY=//p' "$FACTORY_KEY_FILE" | tail -n 1)"
  [ -n "$KEY" ] || KEY="$(tr -d '\r\n' < "$FACTORY_KEY_FILE")"
  KEY="${KEY#\"}"; KEY="${KEY%\"}"; KEY="${KEY#\'}"; KEY="${KEY%\'}"
  KEY_SOURCE="FACTORY_KEY_FILE"
elif [ -s "$KEY_OUT" ]; then
  KEY_SOURCE="existing"
else
  die "no Factory API key: set FACTORY_API_KEY, or FACTORY_KEY_FILE=/path/to/file holding it."
fi
if [ "$KEY_SOURCE" != existing ]; then
  [ -n "$KEY" ] || die "the Factory API key from $KEY_SOURCE is empty"
  case "$KEY" in *[[:space:]]*) die "the Factory API key from $KEY_SOURCE contains whitespace" ;; esac
fi

# ---- generated files --------------------------------------------------------
q() { printf "'%s'" "$1"; } # values are validated to contain no single quotes
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
case "$B$NODE$DROID_BIN$GH_BIN$GIT_BIN" in *"'"*) die "paths must not contain single quotes" ;; esac

render_env() { # $1 = deployment digest
  cat <<ENV
# Generated by scripts/install-native-broker.sh; rerun it to change. No secrets here.
export SPRIITE_NATIVE_OWNER_ID=$(q "$OWNER_ID")
export SPRIITE_NATIVE_MACHINE_ID=$(q "$MACHINE")
export SPRIITE_NATIVE_STORE_DIR=$(q "$STORE")
export SPRIITE_NATIVE_HOST='127.0.0.1'
export SPRIITE_NATIVE_PORT=$(q "$PORT")
export SPRIITE_NATIVE_ENABLE_HOST='1'
export SPRIITE_NATIVE_TRUSTED_HOST='1'
export SPRIITE_NATIVE_HOST_ROOT=$(q "$HOSTROOT")
export SPRIITE_NATIVE_DEPLOYMENT_DIGEST=$(q "$1")
export SPRIITE_NATIVE_FACTORY_KEY_FILE=$(q "$KEY_OUT")
export SPRIITE_NATIVE_EXTENSION_TOKEN_FILE=$(q "$EXT_OUT")
export SPRIITE_NATIVE_DROID_PATH=$(q "$DROID_BIN")
export SPRIITE_NATIVE_GH_PATH=$(q "$GH_BIN")
export SPRIITE_NATIVE_GIT_PATH=$(q "$GIT_BIN")
export SPRIITE_NATIVE_ALLOWED_MODEL_IDS=$(q "$MODELS_JSON")
export SPRIITE_NATIVE_ALLOWED_TOOL_IDS=$(q "$TOOLS_JSON")
export SPRIITE_NATIVE_ALLOWED_ORIGINS=$(q "$ORIGINS_LIST")
# Read X on this Factory host once the phone hands over its X credential.
export SPRIITE_NATIVE_X_READER='1'
ENV
}

PATH_DIRS="$(dirname "$NODE"):$(dirname "$DROID_BIN"):$(dirname "$GH_BIN"):$(dirname "$GIT_BIN"):/usr/local/bin:/usr/bin:/bin"
render_run() {
  cat <<RUN
#!/usr/bin/env bash
# Generated by scripts/install-native-broker.sh. Starts the broker on loopback.
set -euo pipefail
B=$(q "$B")
export PATH=$(q "$PATH_DIRS")
# shellcheck disable=SC1091
. "\$B/broker.env"
SPRIITE_NATIVE_BEARER_TOKEN="\$(cat "\$B/bearer-token")"
export SPRIITE_NATIVE_BEARER_TOKEN
exec >>"\$B/logs/broker.out.log" 2>>"\$B/logs/broker.err.log"
exec $(q "$NODE") "\$B/app/server.mjs"
RUN
}

render_service() {
  if [ "$OS" = linux ]; then
    cat <<UNITFILE
[Unit]
Description=Spriite native broker (Factory Missions on this host)
After=network-online.target
# Stop retrying after repeated failures instead of crash-looping forever.
StartLimitIntervalSec=600
StartLimitBurst=10

[Service]
Type=simple
ExecStart=/usr/bin/env bash "${RUN//%/%%}"
Restart=on-failure
RestartSec=10
UMask=0077

[Install]
WantedBy=default.target
UNITFILE
  else
    cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(xml "$RUN")</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
</dict>
</plist>
PLIST
  fi
}

# One machine-readable line for `spriite pair` (no secrets: the token stays in its file).
summary_line() { # $1 broker URL, $2 via, $3 dry run (0|1)
  "$NODE" -e '
const [os, base, ownerId, machineId, port, servePort, brokerUrl, via, tokenFile, dryRun] = process.argv.slice(1)
process.stdout.write("SPRIITE_INSTALL_SUMMARY " + JSON.stringify({ v: 1, os, base, ownerId, machineId, port: Number(port),
  servePort: Number(servePort), brokerUrl, via, tokenFile, xReader: true, dryRun: dryRun === "1" }) + "\n")' \
    "$OS" "$B" "$OWNER_ID" "$MACHINE" "$PORT" "$SERVE_PORT" "$1" "$2" "$TOKEN_FILE" "$3"
}

say "Spriite native broker installer ($OS)"
say "  base dir:     $B"
say "  service:      $SERVICE_FILE"
say "  owner id:     $OWNER_ID"
say "  machine id:   $MACHINE"
say "  droid:        $DROID_BIN"
say "  gh / git:     $GH_BIN / $GIT_BIN"
say "  node:         $NODE"
say "  models:       $MODELS_JSON"
say "  loopback:     http://127.0.0.1:$PORT"
say "  origins:      $ORIGINS_LIST"

if [ "$DRY_RUN" = 1 ]; then
  step "dry run: nothing is changed"
  say "would copy $REPO/broker/ to $APP/ and install @factory/droid-sdk@0.9.1 there"
  say "would create (mode 0700): $B $HOSTROOT $SECRETS $STORE $LOGS"
  if [ "$KEY_SOURCE" = existing ]; then
    say "would keep the existing Factory API key file $KEY_OUT (mode 0600)"
  else
    say "would write the Factory API key from $KEY_SOURCE (not shown) to $KEY_OUT and $EXT_OUT (mode 0600)"
  fi
  if [ -s "$TOKEN_FILE" ]; then say "would keep the broker token file $TOKEN_FILE (mode 0600)"
  else say "would generate a new broker token in $TOKEN_FILE (mode 0600)"; fi
  step "$ENV_FILE (mode 0600)"
  render_env "<computed at install>"
  step "$RUN (mode 0700)"
  render_run
  step "$SERVICE_FILE"
  render_service
  step "service commands"
  if [ "$OS" = linux ]; then
    say "systemctl --user daemon-reload && systemctl --user enable $UNIT && systemctl --user restart $UNIT"
    say "loginctl enable-linger $(id -un)    # keeps the broker running after you log out"
  else
    say "launchctl bootstrap gui/$(id -u) \"$SERVICE_FILE\"; launchctl kickstart -k gui/$(id -u)/$LABEL"
  fi
  step "exposure"
  if command -v tailscale >/dev/null 2>&1 && [ "$EXPOSE" != none ]; then
    say "would offer: tailscale serve --bg --https=$SERVE_PORT http://127.0.0.1:$PORT   (tailnet only, never funnel)"
    [ "$OS" = linux ] && say "  (on Linux a non-root user needs, once:  sudo tailscale set --operator=$(id -un))"
  else
    say "would print reverse-proxy (Caddy/nginx) instructions for https -> http://127.0.0.1:$PORT"
  fi
  [ "$SUMMARY" = 1 ] && summary_line "" none 1
  exit 0
fi

# ---- install ----------------------------------------------------------------
umask 077
mkdir -p "$APP" "$HOSTROOT" "$SECRETS" "$STORE" "$LOGS" "$(dirname "$SERVICE_FILE")"
chmod 700 "$B" "$HOSTROOT" "$SECRETS" "$STORE" "$LOGS"

step "broker code"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude fixtures --exclude node_modules "$REPO/broker/" "$APP/"
else
  find "$APP" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  (cd "$REPO/broker" && tar --exclude ./fixtures --exclude ./node_modules -cf - .) | (cd "$APP" && tar -xf -)
fi
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || die "npm not found next to $NODE or on PATH"
(cd "$APP" && "$NPM" install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund @factory/droid-sdk@0.9.1 >/dev/null)

step "secrets (0600, never printed)"
if [ "$KEY_SOURCE" != existing ]; then
  for f in "$KEY_OUT" "$EXT_OUT"; do
    rm -f "$f"
    (umask 177; printf '%s' "$KEY" > "$f")
    chmod 600 "$f"
  done
  say "Factory API key written to $KEY_OUT"
else
  [ -s "$EXT_OUT" ] || { cp "$KEY_OUT" "$EXT_OUT"; chmod 600 "$EXT_OUT"; }
  say "kept existing key file $KEY_OUT"
fi
KEY=""
if [ ! -s "$TOKEN_FILE" ]; then
  (umask 177; "$NODE" -e 'process.stdout.write(require("crypto").randomBytes(48).toString("base64url"))' > "$TOKEN_FILE")
fi
chmod 600 "$TOKEN_FILE"

step "deployment digest"
DIGEST="$(cd "$APP" && "$NODE" --input-type=module -e "
import { productionDeploymentBinding } from './host-production.mjs'
const [root, ownerId, machineId, secrets, droidPath, ghPath, gitPath, models, tools] = process.argv.slice(1)
const r = productionDeploymentBinding({ root, ownerId, machineId,
  factoryApiKeyFile: secrets + '/factory-api-key', extensionTokenFile: secrets + '/extension-token',
  droidPath, ghPath, gitPath, allowedModelIds: JSON.parse(models), allowedToolIds: JSON.parse(tools) })
process.stdout.write(r.deploymentDigest)" \
  "$HOSTROOT" "$OWNER_ID" "$MACHINE" "$SECRETS" "$DROID_BIN" "$GH_BIN" "$GIT_BIN" "$MODELS_JSON" "$TOOLS_JSON")" \
  || die "could not compute the deployment digest. Check that droid, gh and git exist, are executable files, and are not writable by other users (chmod go-w <path>)."
say "$DIGEST"

render_env "$DIGEST" > "$ENV_FILE"; chmod 600 "$ENV_FILE"
render_run > "$RUN"; chmod 700 "$RUN"
render_service > "$SERVICE_FILE"; chmod 644 "$SERVICE_FILE"

step "start service"
if [ "$OS" = linux ]; then
  if systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable "$UNIT" >/dev/null
    systemctl --user restart "$UNIT"
    say "systemctl --user status $UNIT"
    if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
      if loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
        say "lingering enabled: the broker keeps running after you log out"
      else
        say "To keep the broker running after you log out, run once:  sudo loginctl enable-linger $(id -un)"
      fi
    fi
  else
    say "No systemd user session found. The unit is at $SERVICE_FILE."
    say "Start it from a login session with:  systemctl --user enable --now $UNIT"
    say "or run the broker directly (for example in tmux):  $RUN"
  fi
else
  uid="$(id -u)"
  launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
  # bootout finishes asynchronously; retry bootstrap briefly.
  for attempt in 1 2 3 4 5; do
    launchctl bootstrap "gui/$uid" "$SERVICE_FILE" 2>/dev/null && break
    [ "$attempt" = 5 ] && die "launchctl bootstrap failed for $SERVICE_FILE"
    sleep 1
  done
  launchctl kickstart -k "gui/$uid/$LABEL"
  say "LaunchAgent $LABEL loaded (it runs while you are logged in)"
fi
sleep 3
tail -n 2 "$LOGS/broker.out.log" "$LOGS/broker.err.log" 2>/dev/null || true

step "HTTPS exposure (the Even app only calls https URLs)"
BROKER_URL=""
use_tailscale=0
if command -v tailscale >/dev/null 2>&1 && [ "$EXPOSE" != none ]; then
  if [ "$EXPOSE" = tailscale ]; then
    use_tailscale=1
  elif [ -t 0 ] && [ "$NONINTERACTIVE" != 1 ]; then
    printf 'Expose the broker on your tailnet only with "tailscale serve --https=%s" (never funnel)? [y/N] ' "$SERVE_PORT"
    read -r answer || answer=""
    case "$answer" in y|Y|yes|YES) use_tailscale=1 ;; esac
  else
    say "tailscale found; rerun with EXPOSE=tailscale to serve on your tailnet, or run:"
    say "  tailscale serve --bg --https=$SERVE_PORT http://127.0.0.1:$PORT"
  fi
fi
if [ "$use_tailscale" = 1 ] && ! tailscale serve --bg --https="$SERVE_PORT" "http://127.0.0.1:$PORT"; then
  # On Linux, tailscaled refuses serve changes from a non-operator user.
  use_tailscale=0
  say "tailscale serve was refused. On Linux, allow your user to manage serve once with:"
  say "  sudo tailscale set --operator=$(id -un)"
  say "then run:  tailscale serve --bg --https=$SERVE_PORT http://127.0.0.1:$PORT"
  say "(or run that serve command with sudo). The broker itself is installed and running."
  if TSNAME="$(tailscale status --json 2>/dev/null | "$NODE" -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  try { process.stdout.write(String(JSON.parse(s).Self.DNSName || "").replace(/\.$/, "")) } catch {} })')" && [ -n "$TSNAME" ]; then
    say "Once served, your broker URL is https://$TSNAME:$SERVE_PORT"
  fi
fi
if [ "$use_tailscale" = 1 ]; then
  TSNAME="$(tailscale status --json 2>/dev/null | "$NODE" -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  try { process.stdout.write(String(JSON.parse(s).Self.DNSName || "").replace(/\.$/, "")) } catch {} })')" || TSNAME=""
  if [ -n "$TSNAME" ]; then BROKER_URL="https://$TSNAME:$SERVE_PORT"; fi
elif [ "$EXPOSE" = none ] || ! command -v tailscale >/dev/null 2>&1; then
  cat <<PROXY
Put a TLS reverse proxy in front of http://127.0.0.1:$PORT. Keep it private
(VPN, firewall allowlist) where you can: an authenticated caller can start
Missions on this host.

  Caddy (automatic certificates), /etc/caddy/Caddyfile:
    broker.example.com {
      reverse_proxy 127.0.0.1:$PORT
    }

  nginx, inside a server block that already has TLS (ssl_certificate ...):
    location / {
      proxy_pass http://127.0.0.1:$PORT;
      proxy_set_header Host \$host;
      proxy_read_timeout 60s;
    }

Your broker URL is then https://broker.example.com (your own name).
PROXY
fi

step "next steps"
say "Broker URL for Setup -> Factory-native: ${BROKER_URL:-<your https URL from above>}"
say "Broker token (paste once on the phone): $TOKEN_FILE"
say "Owner id: $OWNER_ID    Machine id: $MACHINE"
say "Host root (host-managed workspaces): $HOSTROOT"
say "Pack with:  SPRIITE_NATIVE_BROKER=${BROKER_URL:-https://<your broker URL>} npm run pack"
say "Logs: $LOGS"
say "If the phone can't reach the broker but curl with the token works, check ORIGINS: a refused origin is logged in $LOGS/broker.err.log (see docs/NATIVE-BROKER-SETUP.md)."
if [ "$SUMMARY" = 1 ]; then
  if [ -n "$BROKER_URL" ]; then summary_line "$BROKER_URL" tailscale 0; else summary_line "" none 0; fi
fi
