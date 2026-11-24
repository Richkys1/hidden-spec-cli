[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Richkys1/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Richkys1/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` for make.fun's [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty ($100 in USDC). Referral code: `xmc7n7gx`.

Run: `node main.ts [options] [PATCH]` (Node 22, standard library only) with the working directory as the root of a tree of text files. `PATCH` absent or `-` reads stdin; `--` ends options.

## What it does

It reads a patch in one of four formats and applies every edit, or none of them:

- **Unified diff** — `diff --git` sections, `---`/`+++` headers, `@@` hunks, renames, creations, deletions, moves; `\ No newline at end of file` honored.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`, path from the nearest preceding line, fences and prose ignored.
- **V4A** — `*** Begin Patch` … `*** End Patch`, `Add` / `Delete` / `Update File` sections, `@@` anchors, `*** Move to:`, `*** End of File`.
- **JSON edits** — one JSON array or one edit object per line: `create`, `str_replace`, `insert`.

Each edit finds the lines it names at the first of three matching tiers — exact, trailing whitespace ignored, then leading and trailing whitespace ignored (re-indenting the replacement to the file's own indentation) — so a patch whose line numbers drifted or whose whitespace wandered still lands. `--strict` restricts matching to the exact tier.

## Exit codes and output

- `0` — every edit applied. One line per changed path in byte order (`A`/`D`/`M`, or `R <old> -> <new>` for a successful move), then `ok: <n> files`. A file whose bytes did not change is not listed.
- `1` — some edits failed. One `error: <code> <path>` line per failed edit, in patch order (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then `failed: <k> of <n> edits`. No file is written at all.
- `2` — the patch itself is unusable: `error: usage`, `error: no-patch`, `error: format`, `error: parse <N>`.

`--check` reports what would change without writing anything. Paths are checked for safety first (no leading `/`, no `\`, no empty/`.`/`..` segment). CRLF files keep their line breaks; a file without a final line break stays that way unless the patch says otherwise.

## Verification

The kit carries 100 practice checks (`program/generator/practice.json`); `check.ts` runs them:

    node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json

**100 of 100 pass — practice score 1,000** (unified 30, search_replace 20, v4a 20, json 15, cli 15). `grade-local --driver process` on the practice instance reproduces the same score, and the L1 regrade reproduces it byte for byte. Two runs of the same patch on the same tree are byte-identical.

## Files

- `main.ts` — the tool. Node 22, standard library only.
- `runner.ts` — keep as is; the kit's trial harness. Its last lines in `main.ts` hand a trial over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts` — runs the practice set on your own machine.
- `SPEC.md` — the whole specification; every sentence of it is implemented, including the ones the practice set does not exercise.
- `LICENSE` — MIT.
