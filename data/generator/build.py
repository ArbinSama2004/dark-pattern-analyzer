#!/usr/bin/env python3
"""
DATASET BUILD ENTRYPOINT. Dataset only - no model or app code.

Merges the extra slot values and extra templates into the base template bank
so every class can reach its per-language target with genuinely distinct
strings, then runs the generator.

Run:  python3 build.py
"""

import generate_dataset as G
import extra_a
import extra_b

# ---- extra slot vocabularies -------------------------------------------
for lang in G.LANGS:
    G.SLOTS[lang]["BRAND"] = extra_a.BRANDS
    G.SLOTS[lang]["CHANNEL"] = extra_a.CHANNELS[lang]

# ---- merge extra templates --------------------------------------------
added = 0
for bank in (extra_a.EXTRA, extra_b.EXTRA):
    for label, per_lang in bank.items():
        for lang, templates in per_lang.items():
            G.TEMPLATES[label][lang].extend(templates)
            added += len(templates)

print(f"merged {added} extra templates")
for label in G.LABELS:
    counts = {lang: len(G.TEMPLATES[label][lang]) for lang in G.LANGS}
    print(f"  {label:16s} templates/lang: {counts}")

G.main()
