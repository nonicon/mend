[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nonicon/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nonicon/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format.

`mend` applies an edit an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all of them to one written
specification:

- a unified diff (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

It finds the lines an edit names even when the model drifted their
whitespace or indentation, matching at the first of three tiers (exact,
trailing whitespace ignored, surrounding whitespace ignored), and it
changes every file or none: a failed edit is reported and nothing is
written.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Output

- Exit 0: the tree is written. One line per changed path (`A`, `D`, `M`, or
  `R old -> new` for a move), then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. Nothing is written.
- Exit 2: a single error line (`error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`). Nothing is written.

## Requirements

Node 22 and its standard library, nothing else. See `SPEC.md` for the full
contract, and `check.ts` for the practice checks.
