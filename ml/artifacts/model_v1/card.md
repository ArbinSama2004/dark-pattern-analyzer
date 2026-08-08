# Model Card - Dark Pattern Analyzer

## Overview

| | |
|---|---|
| Base model | `google/muril-base-cased` |
| Task | Multi-label text classification, 8 classes |
| Languages | English, Hindi, Nepali |
| Version | 1.0.0 |
| Format | ONNX, fp32 |
| Max sequence length | 64 |
| Input format | `model_input` |

## Labels

0. `confirmshaming`
1. `false_urgency`
2. `forced_action`
3. `obstruction`
4. `scarcity`
5. `sneaking`
6. `social_proof`
7. `benign`

Multi-label with sigmoid outputs and per-class thresholds. A snippet may carry
several labels: *"Only 3 left, ends in 10:00"* is scarcity **and** false urgency.

## Results (synthetic, template-disjoint test split)

**0.9019 macro-F1 (7 dark classes)**

| Language | n | macro-F1 (dark) |
|---|---|---|
| en | 2094 | 0.8891 |
| hi | 2402 | 0.9054 |
| ne | 1922 | 0.9091 |

## Training data

27,000 synthetic snippets generated from 714 templates across three languages.
1,000 per manipulative class per language; 2,000 benign per language. Generator
code is committed in `data/generator/` for full reproducibility.

## Intended use

Research and educational analysis of potentially manipulative interface patterns
on e-commerce websites. Outputs are **heuristic signals for human review**, not
legal determinations.

## Limitations

- **Trained on synthetic data.** Real-world phrasing is more varied and messier.
  Expect materially lower performance on live sites; see `docs/RESULTS.md` for
  the measured gold-set gap.
- **Nepali is the weakest language.** Nepali is under-represented in multilingual
  pretraining corpora.
- **Short snippets only.** Text beyond 64
  tokens is truncated.
- **No visual reasoning.** Colour contrast, size and position asymmetry are
  handled by the deterministic rule layer, not this model.
- **Not a legal tool.** Never presents output as a finding of illegality.

## Ethical considerations

All user-facing copy says "potentially manipulative pattern". False positives
can unfairly damage a business's reputation, which is why the default threshold
profile optimises for precision over recall.
