# QuAiWei · Chinese AI-text humanizer

**Local-first. No API key required. Works offline.**

Rewrites machine-polished Chinese prose so it reads like a person wrote it.
Unlike most projects in this space (a list of rules handed to an LLM), this is a **compiled TypeScript
engine with a regression suite** — every rule is anchored to a real text sample and locked by a test.

> 中文完整文档：[README.md](README.md) · [CHANGELOG](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

---

## What makes it different

| | Rule-list skills | QuAiWei |
|---|---|---|
| Engine | A markdown file the LLM reads | TypeScript engine, **1907 test cases**, CI on every push |
| Runs offline | No (needs an LLM) | **Yes** — default path is local, costs nothing, sends nothing |
| Built-in scoring | No | Yes — heuristic proxy score + explainable per-item trace |
| Real detector loop | No | Optional — Zhuque API (`EdgeOne Makers`) closed loop |
| Who owns "did it get better?" | The model's opinion | A second model acts as judge, plus a fidelity guard that rejects invented facts |

The tools you compare this against at the top of the topic (`blader/humanizer`, `Humanizer-zh`,
`no-ai-slop`, …) are excellent **prompt catalogues**. This is the layer below: something you can
`git clone` and unit-test.

---

## Install

**Try it in your browser** — no install needed: **[online demo](https://fengxingxuerong.github.io/clear/)**

**Desktop (Windows, no install, ~474 MB):** [latest release](https://github.com/fengxingxuerong/clear/releases/latest)
— unzip, double-click `QuAiWei.exe`.

**CLI:**

```bash
npx tsx scripts/humanize-cli.ts ./input.txt --out ./output.txt
```

Input can be a file or a directory (`.txt` / `.md` / `.docx`). Encoding is auto-detected
(UTF-8 / BOM / UTF-16 / GBK); output is always UTF-8.

**As an Agent Skill:**

```bash
npx skills add fengxingxuerong/clear
```

---

## Options worth knowing

| Flag | Default | Notes |
|---|---|---|
| `--intensity <0-1>` | `0.9` | Rewrite strength |
| `--style` | `casual` | `casual` \| `plain` \| `academic` — use `academic`/`plain` for papers and official documents |
| `--zhuque` | off | Injects anti-fingerprint features |
| `--seed <n>` | `20260905` | Fixes randomness, makes runs reproducible |
| `--explain` | off | Emits a per-edit trace: which rule fired, which table it came from |
| `--strict` | off | Refuses delivery and rolls back if facts were invented |
| `--api` | off | LLM deep loop (otherwise pure local engine) |
| `--report <file>` | — | Per-file JSON: timing, word count, engine, round scores, downgrade reasons |

Full list: see the parameter table in `SKILL.md` — it is asserted against the CLI both ways by
`skill-md.test.ts`, so it cannot drift.

---

## Honest disclaimer

**This project does not promise to pass any detector.**

- `aiScore` is a **local heuristic proxy score** (stock-phrase density, sentence-length evenness,
  cadence jumps). It is **not calibrated** to any vendor's number. Comparing before/after on the
  *same* text is meaningful; comparing across texts is not.
- The current evidence ledger for Zhuque official scores has **0/18 points with preserved
  credentials**. That number is stated openly rather than hidden — see `docs/zhuque-official-resubmit-plan.md`.
- "Human baseline" median measures 35 (max 95) on `aiScore`. **A low score does not prove it reads
  human; a high score does suggest stock phrasing.**

## License

MIT
