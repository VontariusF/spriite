# Validation Strategy

The approved agreement (`contract`) is the source of truth for the exact export, greeting text, test runner, repository boundaries, and local commit. The repository (`deliverable`) is observed directly through source inspection, test execution, and Git inspection.

`feature-shape` establishes the structural and exact-behavior requirements without inferring correctness from the implementation alone: its expected export, test framework, assertion, and script come from `contract`. This catches a default export, wrong punctuation, a non-discovered test filename, or a substituted test tool.

`npm-test-passes` executes the user-required command and requires one discovered, passing test with no omitted outcomes. Requiring the delivered test count prevents the pre-implementation zero-test success from passing validation.

`local-commit-complete` separately establishes the local Git outcome and boundaries. It checks `main`, the tip commit contents, the absence of uncommitted changes to in-scope paths, and the continued untracked, uncommitted state of `ANSWERS.md` and `CANARY.md`. This is necessary because a passing test does not show that the requested files were committed safely.

These checks are exhaustive for the small promised surface. No network, browser, performance, cross-version, non-string input, or publication validation is appropriate because those concerns are explicit non-goals. The existing test script and local Node/npm path were exercised during planning, so no new validation instrument is required.
