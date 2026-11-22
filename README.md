# mend

[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alyssaxacexdaemon-bot/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alyssaxacexdaemon-bot/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. mend reads the patch in any of the four, finds the lines each edit names at the first of three matching tiers, and writes every change or none, printing what it changed or why it failed.

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`--format` names `unified`, `search-replace`, `v4a`, `json` or `auto` (the default, which detects the format). `--check` does everything but write. `--strict` matches lines exactly (tier 0 only). `PATCH` is the path of the patch file, relative to the working directory; when it is absent or `-`, the patch is read from standard input.

Practice score: **1000** — 100 of 100 practice checks passed (unified 30/30, search-replace 20/20, v4a 20/20, json 15/15, cli 15/15).

Built for the [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) mend bounty. Node 22 and its standard library only.
