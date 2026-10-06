# Set up Spriite

Build, connect, and install Spriite on Even Realities G2.

[Back to the README](../README.md)

### 1. Get the code

```bash
git clone https://github.com/VontariusF/spriite.git
cd spriite
npm install
```

### 2. Deploy your relay

Glasses apps like this run as web pages inside the glasses' phone app.
Factory and Cursor don't accept requests from web pages they don't own
(they send no CORS headers), so Spriite needs a tiny relay that forwards
your requests and adds those headers. It's under 150 lines in
[`relay/`](../relay/), stores nothing, logs nothing, and only talks to
`api.factory.ai` and `api.cursor.com`.

Because you run it, your keys never pass through anyone else's server.

Deploy it as a Cloudflare Worker. It's free, always on, and takes about
two minutes with a free Cloudflare account:

```bash
cd relay
npx wrangler login         # first time only; opens Cloudflare in your browser
npx wrangler deploy        # prints https://spriite-relay.<you>.workers.dev
curl https://spriite-relay.<you>.workers.dev/health   # -> spriite relay ok
```

That URL is your relay. Other hosts work too (any platform that runs a
standard `fetch` handler, or a machine you keep online behind an HTTPS
tunnel); see [`relay/README.md`](../relay/README.md).

### 3. Build Spriite against your relay

In the [Even Hub developer portal](https://hub.evenrealities.com/hub),
create a project for your copy and note its package id (for example
`com.yourname.spriite`). Package ids are unique per developer account, so
use your own. Then:

```bash
cp .env.example .env.production.local   # git-ignored
# edit it: VITE_SPRIITE_RELAY=<your relay URL>, SPRIITE_PACKAGE_ID=<your package id>
npm run pack               # -> spriite.ehpk for your project, allowing only your relay
```

The relay address is baked into your build and added to the app's network
allowlist, and your package id replaces the default. `app.json` itself is
never edited. The Even app checks that allowlist before any request leaves
the phone and accepts exact addresses only, which is why each person builds
their own copy: there's no way to ship one build that reaches everyone's
relay. If you move your relay, rebuild and upload again.

`npm run pack` refuses to build without a relay, because such a build can't
reach Factory or Cursor on a phone. `npm run pack -- --no-relay` makes a
demo-only build.

### 4. Install it on your glasses

For Even Realities G2: upload `spriite.ehpk` to your project in the
[Even Hub developer portal](https://hub.evenrealities.com/hub).

- **Private build** (Private builds tab): install from the phone app under
  Me → Apps → Private builds. Quickest way to check it boots, but it only
  survives backgrounding briefly.
- **Beta build** (move the build to Test and add yourself to a beta group):
  the same install path a store app uses, and it keeps running with your
  phone locked. Use this for daily use.

### 5. Keep a Factory computer online

Factory runs every session on a **Droid Computer**, and Spriite needs one
whenever it starts or continues a mission: the lead session that plans and
reviews runs there, and so do Factory workers. Spriite uses the computer you
pick in Setup if it's active, otherwise the first active computer in your
account. You need one of these:

- **Your own machine (Mac, Linux, or Windows).** It must be registered with
  Factory and its Droid daemon must be connected with remote access. Either
  open the Factory app on it and turn on **Settings → Droid Computers →
  Remote Access** (it stays connected while the app is running), or run:

  ```bash
  droid daemon --remote-access   # registers the machine on first run
  ```

  No inbound ports are opened; the daemon connects out to Factory's relay.
  The machine has to stay awake and online while you build, so run the
  daemon as a login service (a launchd agent on macOS, a systemd service on
  Linux) if you'll use Spriite away from it. Factory sessions on your
  machine use the git credentials already configured there, so make sure
  it can clone and push to your repository.
- **A Factory-managed cloud computer.** Create one under **Settings → Droid
  Computers → Create** in the Factory app. It pauses when idle and wakes
  when a session targets it, and it gets GitHub access through your
  Factory GitHub integration.

Check what Factory sees with `droid computer list`. If the machine is listed
but its daemon isn't connected, Spriite shows **Computer offline** on the
glasses and explains why on the phone; start the daemon and tap **Retry**.
If your account has no active computer at all, Spriite asks you to connect
one before it starts.

### 6. Connect your accounts

Open Spriite's page in the phone app and go to **Setup**. A checklist walks
you through Factory, repository, voice, Cursor, and GitHub. Each key is
proven with one lightweight call when you save it, then stored only on your
phone. Saves apply to the glasses immediately.

### 7. Start a mission

On the glasses, pick **New build** and tap Talk, or type a goal in the
phone's **Tell Spriite** box.

### Try it without a relay

For development, the dev server proxies Factory and Cursor itself, so no
relay is needed:

```bash
npm run dev                                   # http://localhost:5173
npx evenhub qr --url http://<your-lan-ip>:5173   # scan with the glasses' phone app
```

The phone and the dev machine must share a network (a private overlay
network such as Tailscale also works). This mode stops when the phone
locks, so use a relay build for real use.


