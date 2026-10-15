# Host GitHub: the phone needs no GitHub token when paired

## Goal

When the phone is paired with a Spriite host whose `gh` CLI is signed in,
every GitHub call the phone makes runs on the host, through the broker, with
the host's own `gh` login. That covers creating a new repository, finding one,
reading the account, the repository/branch/pull-request evidence reads and the
repository listings. The phone never needs a GitHub token in that case. A token
saved on the phone stays as the fallback for phones with no paired host, or a
host without a GitHub login.

Why the host and not Factory: Factory reaches GitHub through its GitHub App,
which Droids use for repositories it is installed on. It offers no
repository-create call, and an app installation cannot create repositories in
a personal account. The host already holds the owner's `gh` login and uses it
for delivery (`broker/native-delivery.mjs`), so it is the one place the
credential should live.

## Contract

### Capability

`GET /v1/native/capabilities` gains

    github: { available: boolean, login: string | null }

`available` is true when `gh auth status` succeeds for github.com and
`gh api user` returns a login. A yes is cached for 5 minutes, a no for 30
seconds. Each probe step is bounded at 5 seconds, and the route waits at most 3
seconds on a probe before answering unavailable for now (the probe still
settles into the cache), so a slow `gh` never stalls the other capabilities.
The token never appears in any response, log or error.

### One narrow GitHub route

`POST /v1/native/github/call`, with the same bearer auth and origin rules as
every other broker route. Body:

    { method: 'GET' | 'POST', path: string, body?: object }

Response: `{ status: number, body: unknown }`. This is GitHub's own status and
parsed JSON, so the phone's existing parsing and error mapping stay unchanged.
Size cap 1 MB. No headers are forwarded either way.

This is an allowlist, not a proxy. Anything not listed is refused with
`403 github_call_refused` before `gh` runs:

- `GET` on exactly the REST paths `src/factory/github.ts` and the phone's
  repository listings use today. The implementer enumerates them from the code
  and pins each one as an anchored pattern. Owner, repo, branch, ref and number
  segments are validated, and only the query keys the phone sends are allowed.
- `POST /user/repos` only, with the body exactly
  `{ name, description, private: true, auto_init: true }`. `private` must be
  true (a public create is refused), `name` matches GitHub's repository-name
  rules, and `description` is at most 350 characters. This mirrors
  `githubCreateRepo`, so a host-created repository is the same as a
  phone-created one.
- No PATCH/PUT/DELETE, no other POST, no GraphQL, no paths outside the list.

`gh` runs through the existing production runner (no shell, bounded output,
timeout, the limited env passthrough) as
`gh api --method <M> <path> [--input -]`, adding `--include` only if needed to
recover the status. A 422 "name already exists" keeps its GitHub status and
body, so the phone's `exists` mapping (and the `-2`/`-3` fallback) works
unchanged. Calls are bounded: at most 4 run at once, then `429
github_call_busy`.

### Phone

- `src/factory/github.ts`: the token-based `call` becomes one transport behind
  a small interface. A host transport sends the same `(method, path, body)` to
  the broker route and turns the reply into the same results and `GitHubError`
  kinds.
- Selection, in one place used by `liveClients` (`src/factory/real.ts`), the
  durable runtime (`src/runtime/outbox.ts` / supervisor), the intake GitHub
  source, the X panel repository listing and the setup Repo screen:
  1. Paired host with `github.available` → the host transport.
  2. Otherwise a GitHub token saved on the phone → the token transport.
  3. Otherwise nothing, and the existing `blockedStart: 'github'` prompt.
- `blockedStart 'github'` and the composer help line fire only in case 3. Their
  copy becomes: "Spriite needs GitHub to create the repository. Pair with your
  computer (it uses its GitHub sign-in), or add a GitHub token in Settings."
- Settings → GitHub shows "Through <host label>" when the host provides it.
  Record this in `docs/design/deviations/phone.md` because the board has no
  such state.
- Existing behaviour with a phone token and no host is unchanged.

## Out of scope

Host-side X reading, Cursor, and any GitHub write beyond the private repository
create.

## Tests

- Broker:
  - every allowlisted call passes and every other method/path/body is refused
    before `gh` runs;
  - a public create is refused;
  - 422 exists passes through;
  - auth and origin match the other routes;
  - the concurrency cap returns 429;
  - nothing that could hold the token shows up in any response or log;
  - the capability's `available` and `login` come from a fake `gh`.
- Phone:
  - the transport maps replies to the same results and errors as the token path;
  - selection order 1/2/3;
  - a new repo with no phone token and a paired host creates through the host
    and plans;
  - with neither, the prompt and the new copy.
- `scripts/qualify.mjs` stays green. Register any new suite as a package script
  and a qualify SUITES row.
- No test creates a real GitHub repository. A live smoke against the installed
  host may run only a read: the capability, plus `GET /user`.

## Done

The code is committed on `redesign/v2` (not pushed). The broker is reinstalled
on this Mac with `scripts/install-native-broker.sh --non-interactive` and
`DROID=/Applications/Factory.app/Contents/Resources/bin/droid`, which keeps the
existing env/key/token. The package is repacked with
`SPRIITE_NATIVE_BROKER=https://<your-factory-host>.<your-tailnet>.ts.net:47822 npm run pack`
and copied to `spriite-0.3.0.ehpk`.
