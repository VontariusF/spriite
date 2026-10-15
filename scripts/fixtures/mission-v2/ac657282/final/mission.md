# Greet Function Mission

## Objective

Add one small JavaScript feature to `/tmp/spriite-canary/work`: a named `greet(name)` export, a Node test covering its exact greeting, and a passing local `npm test` workflow. Commit the finished feature locally on `main`.

## Required outcome

1. `/tmp/spriite-canary/work/greet.js` exports a named function `greet(name)`.
2. `greet(name)` returns the JavaScript template result `Hello, ${name}!`; for example, `greet("Ada")` returns exactly `Hello, Ada!`.
3. `/tmp/spriite-canary/work/greet.test.js` uses the built-in `node:test` runner and asserts the required exact result.
4. `package.json` has a `"test": "node --test"` script. The existing matching script may be preserved unchanged.
5. `npm test` exits successfully and executes the greeting test with no failures, skips, cancellations, or todos.
6. The completed requested changes are committed locally on `main`.

## Scope

- Repository deliverables: `greet.js`, `greet.test.js`, and `package.json` only if its already-correct test script needs a change.
- One implementation worker.
- Existing ES module conventions from `package.json` remain in use.

## Boundaries

- Repository work is limited to `/tmp/spriite-canary/work`.
- Do not push, add or change remotes, open pull requests, publish, deploy, or use network services.
- Do not modify, stage, or commit the pre-existing untracked `ANSWERS.md` or `CANARY.md`.
- Do not modify `README.md` or unrelated repository content.
- Commit directly and locally on the existing `main` branch using the configured Git identity.
- Mission control records remain in the runtime-assigned Mission directory.

## Sources of truth

- This approved agreement governs scope, behavior, boundaries, and completion.
- The user's requested greeting string and test command are represented verbatim in the required outcome.
- The repository state at planning time establishes the existing ES module configuration and the already-correct test script.

## Non-goals

- Input validation, type restrictions, default names, CLI behavior, browser behavior, or additional greeting formats.
- Additional dependencies, tooling, test frameworks, documentation, refactoring, publication, or remote Git activity.
- Testing JavaScript coercion for non-string inputs beyond the required interpolation behavior.

## Consequential assumptions and risks

- Node.js 22.23.1 and npm are available locally. Planning ran the current `npm test` command successfully, with zero tests.
- The existing `"type": "module"` setting means the implementation and test will use ES module syntax.
- The dominant risks are an incorrect export shape or exact string, a test that is not discovered, and accidentally including protected untracked user files in the commit.

## Implementation approach (non-binding)

Have one worker add a minimal named function in `greet.js` and a single focused `node:test` case in `greet.test.js`. Preserve `package.json` because its requested script is already exact. Then run `npm test`, inspect the diff and Git status, stage only the in-scope files, commit on `main`, and verify the final commit and protected untracked files.

## Readiness

- Planning inspected `package.json`, `README.md`, and the two protected untracked files.
- `package.json` already declares ES modules and `"test": "node --test"`.
- `node --version` returned `v22.23.1`.
- The existing `npm test` completed successfully with zero discovered tests.
- Git is on `main` at `597b65cc8b4721e89168f2439384cb74e045f8da`.
- No network, remote, deployment, or external service is needed.

## User decisions

No mid-Mission product decision is expected. The user delegated ordinary implementation details and requested no planning questions.
