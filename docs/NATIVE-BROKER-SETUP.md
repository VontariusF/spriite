# Run the native broker on your Factory host

The native broker lets Spriite run builds as **Factory Missions** directly on a
machine you control, and lets that machine read your X requests while Spriite
is closed on the phone. Each person runs their own broker on their own Factory
host. Nothing is shared between installations.

[Back to the setup guide](SETUP.md)

**Your Factory host** is the machine where Factory's `droid` CLI is installed and
signed in, and where the Spriite broker runs. It can be a Linux VPS, a home
server, or a Mac. Windows is not supported.

## Native broker or cloud path?

| | Cloud path (default) | Native broker |
|---|---|---|
| Where the lead runs | A Factory session on your Droid Computer, driven from the phone through your relay | A Factory Mission started by the broker on your Factory host |
| What you host | The relay ([SETUP.md](SETUP.md)) | The relay, plus this broker |
| X requests | Read while Spriite is open on the phone | Read by the Factory host while the broker runs ("Read X on my Factory host"): around the clock on Linux with lingering, while you are logged in and the Mac is awake on macOS |
| Workers | Factory sessions and Cursor cloud agents | Mission workers on your Factory host |

You can use Spriite without the broker. It is an explicit opt-in per build.

## Requirements

On your Factory host:

- **Linux** (with systemd, for the user service) or **macOS**.
- **Factory `droid`**, installed and signed in. Run `droid` once so it writes
  `~/.factory/computer.json`; the installer reads the machine id from there.
- **A Factory API key** for your account.
- **Node.js 22.18 or newer** (or 23.6+, 24+), with npm. The broker loads a
  TypeScript module directly, which older Node 22 releases can't do without a
  flag. Ubuntu's own `nodejs` package is older; install Node with nvm, fnm,
  volta, asdf or NodeSource. The broker adds its Node's directory to every
  Mission's `PATH`, so `node`, `npm` and `npx` work in Missions however Node was
  installed.
- **git**.
- **GitHub CLI (`gh`)**. It must be installed. Run `gh auth login` on the host if
  your deliveries will push branches or open pull requests; the broker performs
  those steps itself, outside the agent sandbox.
- **HTTPS reachability from your phone**, through Tailscale or a reverse proxy
  with TLS (see below). The Even app only calls `https` addresses that were packed
  into your build.

## Install

The quickest way is `spriite pair`, which installs or starts the broker and then
hands its URL, token, owner and machine ids to your phone, encrypted, in one
step (no pasting):

```bash
npx spriite pair                                    # once the package is published
npm run pair -- --relay https://relay.example.com   # from a checkout, until then
```

On a first install it runs the installer below non-interactively
(`--non-interactive --summary`) with the Factory key it found and the model ids
you give it (`MODELS='["<model-id>"]'`, or it asks once). An existing install and
its `broker.env` are reused as they are; a stopped service is started. See
[SETUP.md](SETUP.md#2-pair-with-your-factory-computer).

To install by hand, from your Spriite checkout on the Factory host:

```bash
MODELS='["<model-id>"]' FACTORY_API_KEY=<your-key> scripts/install-native-broker.sh
```

Or keep the key out of your shell history with a file (it may hold the bare key
or a `FACTORY_API_KEY=...` line):

```bash
MODELS='["<model-id>"]' FACTORY_KEY_FILE=~/factory-key scripts/install-native-broker.sh
```

`MODELS` is a JSON array of the Factory model ids this broker may run. There is
no default: pick ids your account can select in droid (the `/model` picker). The
models you choose later in the phone's Mission settings and X template must be in
this list.

Preview everything first with `--dry-run`. It prints the service file, the
environment and the files it would write, and changes nothing:

```bash
MODELS='["<model-id>"]' FACTORY_API_KEY=<your-key> scripts/install-native-broker.sh --dry-run
```

The installer:

1. Copies `broker/` into the broker directory and installs `@factory/droid-sdk`
   there.
2. Writes your Factory API key to a `0600` file. It never prints the key.
3. Generates a broker token (`bearer-token`, `0600`) the phone uses to call the
   broker. An existing token is kept.
4. Records a deployment digest of the exact droid, gh, git and broker code.
5. Installs and starts a per-user service that listens on `127.0.0.1` only.
6. Offers HTTPS exposure, then prints the broker URL and where the token is.

Rerun it any time to refresh the broker after `git pull`. On a refresh you can
leave out the key and `MODELS`; the installed ones are kept.

### Where things go

| | Linux | macOS |
|---|---|---|
| Broker directory | `${XDG_DATA_HOME:-~/.local/share}/spriite/native-broker` | `~/Library/Application Support/Spriite/native-broker` |
| Service | `~/.config/systemd/user/spriite-native-broker.service` | `~/Library/LaunchAgents/ai.spriite.native-broker.plist` |
| Manage it | `systemctl --user status\|restart spriite-native-broker` | `launchctl kickstart -k gui/$(id -u)/ai.spriite.native-broker` |

Set `SPRIITE_HOME` to use a different broker directory. Inside it: `secrets/`
(the key files), `bearer-token`, `broker.env` (configuration, no secrets),
`run.sh`, `store/`, `host/` (job checkouts) and `logs/`.

On Linux the installer enables lingering so the broker keeps running after you
log out. If your account can't, it prints the command to run once:
`sudo loginctl enable-linger <your-user>`. On macOS a LaunchAgent runs while you
are logged in.

### Options

| Variable | Default | Meaning |
|---|---|---|
| `MODELS` | none (required first time) | JSON array of allowed model ids |
| `FACTORY_API_KEY` / `FACTORY_KEY_FILE` | kept on refresh | Your Factory API key |
| `OWNER` | `owner-<your login name>` | Broker owner id you enter on the phone |
| `DROID` | `droid` on PATH, `~/.local/bin/droid`, then Factory.app on macOS | droid executable |
| `GH`, `GIT`, `NODE` | from PATH | Executables |
| `TOOLS` | the standard droid tool set | JSON array of allowed tool ids |
| `ORIGINS` | `*` (any) | Comma-separated exact browser origins allowed to call the broker, or `*` |
| `PORT` | `47821` | Loopback port |
| `SERVE_PORT` | `47822` | HTTPS port for `tailscale serve` |
| `EXPOSE` | `auto` | `tailscale` to serve without asking, `none` to skip Tailscale |
| `SPRIITE_HOME` | per OS, above | Broker directory |

## Expose it over HTTPS

The broker listens on loopback only. Your phone needs an HTTPS address for it.

**Tailscale (recommended).** If `tailscale` is installed, the installer offers:

```bash
tailscale serve --bg --https=47822 http://127.0.0.1:47821
```

On Linux, `tailscaled` refuses serve changes from a user that is not its
operator ("Access denied: serve config denied"). Allow your user once with
`sudo tailscale set --operator=$(id -un)`, or run the serve command with `sudo`.
If serve is refused, the installer still finishes and prints these commands.

This serves the broker to devices on your tailnet only. Never use
`tailscale funnel` for the broker. Your broker URL is
`https://<host>.<your-tailnet>.ts.net:47822`, printed by the installer. Your
phone must be on the tailnet.

**A reverse proxy with TLS.** Without Tailscale, put Caddy or nginx in front of
`http://127.0.0.1:47821`. With Caddy, which gets certificates automatically:

```
broker.example.com {
  reverse_proxy 127.0.0.1:47821
}
```

With nginx, in a server block that already has TLS configured:

```
location / {
  proxy_pass http://127.0.0.1:47821;
  proxy_set_header Host $host;
  proxy_read_timeout 60s;
}
```

Use a name you control in place of `broker.example.com`. Every route needs the
broker token, but anyone holding it can start Missions on your host, so keep the
address private where you can (a VPN, or a firewall allowlist).

**Browser origins.** The Even app's WebView origin is set by the glasses host,
and can be the opaque `null`, so by default the broker accepts any `Origin`
(`ORIGINS='*'`). That is safe because CORS is not what protects the broker: every
request needs the bearer token, and the broker uses no cookies. To restrict it,
rerun the installer with `ORIGINS=<origin>,<origin>` (exact origins; `null` is
allowed as a literal).

## Trusted-host mode and its risks

The installer runs the broker in **owner-trusted host mode**
(`SPRIITE_NATIVE_TRUSTED_HOST=1`). This is your decision to run Missions on your
own machine without a signed host qualification. In plain terms, you accept that:

- **Agent code can read your Factory API key.** A job's agents run with the key in
  their environment, as they do when you run `droid` yourself.
- **Agents are not fully isolated from your files.** A denylist protects the
  broker's own secrets, not everything your user account can read. Use a host,
  or a user account, without data you would not hand to an agent.
- **Stopping a job is best effort.** Each droid daemon runs in its own process
  group and stopping a job signals the whole group, but a process that detaches
  into a new session (`setsid`) can survive until the service restarts.
- **A broker restart re-prepares** an open request instead of recovering it.

Still enforced: your consent for each build's scope and High autonomy, the model
and tool allowlists, destination and consequence rules (merge needs a PR, a PR
needs a push), and no budget-capped launches. Details:
[`broker/README.md`](../broker/README.md#owner-trusted-host-mode).

## Set up the phone

`spriite pair` sets the phone up for you: the broker URL, its token (bound to
that URL), the owner and machine ids and the base ref arrive with the pairing
bundle and prefill **Settings › Advanced › Factory-native details**, never
overwriting a field you already filled. X sign-in then opens on this host
(PKCE with a loopback redirect on `http://127.0.0.1:47823/x/callback`, port
`SPRIITE_X_SIGNIN_PORT`; client id from the phone or `SPRIITE_X_CLIENT_ID`), so
the phone never handles X token JSON.

To set it up by hand, open **Settings › Advanced › Factory-native details** and enter:

- **Broker URL**: the HTTPS URL from the installer (no token in it).
- **Broker credential**: the contents of the `bearer-token` file the installer
  names. Paste it once; it is kept in the phone's key vault.
- **Broker owner/account ID**: the owner id the installer printed.
- **Selected computer/machine ID**: the machine id the installer printed (from
  `~/.factory/computer.json`).
- **Base ref**: the full ref builds start from, such as `refs/heads/main`.
- **Workspace allocation**: `host_managed` lets the broker create a fresh
  checkout per job. Its host root is the `host/` path the installer printed.

For X requests on the native path:

1. Fill in the models, tools, acceptance criteria and restrictions in
   Factory-native, then under **X requests** tap **Save these settings for X
   requests**. This is the X template every X build launches with. Its models
   and tools must be in the broker's `MODELS` and `TOOLS`.
2. Turn on **X builds run as Factory Missions on my Factory host**, and, if you
   want tagged posts to launch without review, **Run my X requests automatically
   as Factory Missions**.
3. In **Settings → X**, tap **Sign in on <host>**: the sign-in opens in a
   browser on this host and the broker keeps the credential. When an X reader
   configuration already exists the host resumes reading on its own; otherwise
   tap **Read X on my Factory host**, which sends only the reader settings
   (handle, X template, delivery defaults) and the broker joins the token pair
   its sign-in holds. No token travels to the phone. (A credential an older
   phone already held can still be handed over the same way; **Read X on this
   phone again** hands reading back.)

## Pack your build with the broker

The Even app only reaches addresses packed into your build. Add the broker URL to
`.env.production.local` or pass it when packing:

```bash
SPRIITE_NATIVE_BROKER=https://<your broker URL> npm run pack
```

Upload the new `spriite.ehpk` as in [SETUP.md](SETUP.md#4-install-it-on-your-glasses).
If the broker URL changes, pack and upload again.

## Troubleshooting

Logs are in the broker directory under `logs/` (`broker.out.log`,
`broker.err.log`). On Linux, `journalctl --user -u spriite-native-broker` shows
service start failures.

**The broker or droid daemon refused to start.**

- `native_deployment_digest_mismatch`: droid, gh, git, Node or the broker code
  changed since install (for example droid updated itself). Rerun the installer.
- `native_host_binary_unsafe`: an executable is missing, not executable, or
  writable by other users. The installer names the file; fix it with
  `chmod go-w <path>`, or point `DROID`, `GH` or `GIT` at a safe copy, and rerun.
  A file you own that is writable only by your own primary group (as Factory's
  droid install leaves it under Ubuntu's default umask 002) is accepted.
- `native_node_version_unsupported`: the broker's Node is older than 22.18.
  Install a newer Node, then rerun the installer (with `NODE=/path/to/node` if it
  isn't first on your `PATH`).
- `writer_locked`: another broker process holds the store. At startup the broker
  releases a lock left by a broker process on this host that no longer exists
  (after an OOM kill, `SIGKILL` or power loss). If it still fails, check that no
  second broker is running (`systemctl --user status spriite-native-broker`, or
  `ps`), then remove `<broker dir>/store/.writer` and restart the service. On
  Linux, after repeated failures systemd stops retrying; once fixed, run
  `systemctl --user reset-failed spriite-native-broker` and restart it.
- `host_configuration_required` or `native_host_configuration_required`:
  `broker.env` or the token file is missing or incomplete. Rerun the installer.
- `loopback_only`: the broker only binds `127.0.0.1` or `::1`. Expose it through
  Tailscale or a proxy instead.
- A job holds because droid can't start: run `droid` on the host as the same user
  and sign in again, then check `droid computer list`.

**Authentication.** A `401` from the broker means the phone's credential doesn't
match `bearer-token`. Paste the file's contents again. Factory errors inside a
job mean the API key is wrong or revoked: rerun the installer with a fresh
`FACTORY_API_KEY`. Push or PR failures mean `gh` isn't signed in on the host:
run `gh auth login` as the broker's user.

**The phone says it can't reach the broker, but `curl` with the token works.**
Check `ORIGINS`. `curl` sends no `Origin` header, so it passes where the app's
browser request is refused; the browser then reports only that the broker is
unreachable. The broker logs each refused origin once in
`<broker dir>/logs/broker.err.log` ("Native broker refused browser origin ...").
Add that value to `ORIGINS`, or use the default `ORIGINS='*'`, and rerun the
installer.

**The phone can't reach the broker at all.** Check that the URL is `https`, that
it was packed into the build you installed, and, with Tailscale, that the phone
is connected to your tailnet. From another tailnet device,
`curl -H "Authorization: Bearer $(cat <broker dir>/bearer-token)" https://<broker URL>/v1/native/capabilities`
should return JSON.
