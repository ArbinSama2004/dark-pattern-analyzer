# Annotation rules

This document exists because v2 contained a label contradiction that cost real
accuracy. Writing the rule down is how that class of defect gets prevented.

## The core test

> A statistic is **manipulative** when it induces urgency or peer pressure through
> **unverifiable real-time activity**.
> It is **benign** when it is a **static, verifiable aggregate**.

The same test applies to deadlines:

> A **real stated deadline** is benign. A **fabricated or resetting** one is dark.

The distinction is not "does this mention a number" or "does this create urgency".
Legitimate commerce creates urgency constantly: shipping cutoffs, genuine sale end
dates, real low stock. What makes a pattern dark is that the pressure is
**manufactured and unverifiable**.

## social_proof

| Dark | Benign |
|---|---|
| `{N} people are viewing this right now` | `{N} verified reviews` |
| `{NAME} from {CITY} just bought this` | `Rated by {N} verified buyers` |
| `Someone in {CITY} purchased X minutes ago` | `Bestseller - {N} sold this week` |
| `{N} bought in the last {H} hours` | `Based on {N} verified purchases` |
| `{N} reviews - join them` | `Average rating from {N} reviews` |
| `Trending #1 in {PRODUCT}` | `Ranked #{N} in this category by sales` |
| `Most loved by shoppers in {CITY}` | `Reviews are from confirmed buyers only` |

The left column claims **live activity you cannot check**. The right column reports a
**settled total you could audit**. `{N} reviews - join them` is dark not because of the
count but because of `join them` - the count is being weaponised into pressure.

## false_urgency

| Dark | Benign |
|---|---|
| `Sale ends in {TIME}!` | `Order in {TIME} to get delivery in {DAYS} days` |
| `Your cart will expire in {TIME}` | `Estimated delivery: {DAYS} days` |
| `Prices go up in {TIME}` | `Sale ends 31 December` (a fixed, real date) |
| `Extended by popular demand - final {H} hours` | `Cash on delivery available in {CITY}` |

`Order in 2 hours to get delivery in 3 days` is a **logistics fact**: a warehouse
cutoff. Nothing is lost by ignoring it except speed. Contrast `Your cart will expire
in 09:59`, where the deadline is invented and typically resets on reload.

## Why this matters more than it looks

In v2, `Rated by {N} verified buyers in {CITY}` was labelled **social_proof** while
`{N} verified reviews` was labelled **benign**. Two phrasings of one concept, opposite
labels. Consequences, all measured:

- social_proof tuned threshold collapsed to **0.13** - the model could not find a
  confident boundary, so tuning pushed the cutoff to the floor.
- **126 of 661** social_proof test rows (19%) leaked into false_urgency and scarcity.
- social_proof F1 fell from 0.882 (v1) to **0.813** (v2), the worst regression of any class.
- 4 of 8 sampled false negatives were the delivery-cutoff template, where the model
  predicted `[]` and **was correct**.

A model cannot learn a boundary that the labels themselves do not agree on. The ceiling
was set by the annotation, not the architecture.

## Checks that enforce this

`make data-check` catches exact-text collisions. It **passed on v2** and missed all of
the above, because the contradiction was conceptual, not literal - the two templates
never produced an identical string.

So v2.1 adds a **concept-keyword consistency check**: for each listed concept, every row
containing its keywords must carry the same label set. This check also reports keyword
collisions, which are **not** defects:

- `verify your account to get the discount` is **forced_action** - shares the word
  "verify" with the review concept, different meaning.
- `Rs. 299 handling fee on {CITY} delivery` is **sneaking** - shares "delivery" with the
  shipping-cutoff concept, different meaning.

A flag means *inspect*, not *fix*. Read the sampled rows before changing any label.

## Rule for adding templates

1. Write the template.
2. Apply the test above out loud. If you hesitate, the template is ambiguous - either
   sharpen the wording or move it to the benign hard-negative list.
3. Grep the existing benign list for the same concept before assigning a dark label.
4. Re-run the concept check.

Step 3 is the one that was skipped in v2.

## Stage 4 note

These rules govern the **synthetic** data. The hand-annotated gold set uses the same
rules, which is the point: if the definitions differ between training and evaluation,
the gold-set score measures disagreement about definitions rather than model quality.

If a second annotator is available, measure Cohen's kappa on the gold set. The
categories where two reasonable people could disagree - chiefly social_proof versus
benign aggregates - are exactly where kappa will be lowest, and reporting that is more
valuable than hiding it.

---

## Building the gold set

### 0. If your captures are already in MinIO

```bash
make gold-fetch                        # everything, into ./traces/
make gold-fetch HOST=www.daraz.com.np  # one site
```

Reads the bucket directly rather than the SQLite index, so it still works if the
index was deleted or the bucket was written by another machine.

### 1. Capture real pages

Browse the sites you want covered with the extension running, and press **"Save this
scan to the archive"** on each. Traces land in MinIO. The extension's popup
"Download debug trace (JSON)" button produces the same content as a local file if you
would rather not run MinIO.

Aim for spread rather than volume: several hosts, both a listing page and a product
page per host, and pages that genuinely contain Devanagari text if the per-language
table is to mean anything.

### 2. Generate the annotation sheet

```bash
make gold-candidates TRACES='path/to/traces/*.json'
```

Writes `data/gold/candidates.csv`, sampling ~400 rows stratified by predicted label
and language, **half from candidates the model flagged and half from candidates it
called benign**. That split is deliberate: a sheet of only flagged rows can measure
precision but is structurally incapable of finding a false negative.

### 3. Annotate

#### Quick reference — keep this visible while working

Ask one question per row: **is the pressure manufactured and unverifiable?**

| Type | If the text... | Example |
|---|---|---|
| `scarcity` | claims limited stock/availability you cannot verify | "Only 2 left in stock!" |
| `false_urgency` | sets a deadline that is fabricated or resets | "Offer ends in 09:58" |
| `social_proof` | cites live activity by others as pressure | "37 people viewing this" |
| `confirmshaming` | shames or guilts you for declining | "No thanks, I hate saving" |
| `forced_action` | demands an unrelated action to proceed | "Create an account to view prices" |
| `obstruction` | makes an action harder than it needs to be | "Cancel by phoning 9-5" |
| `sneaking` | slips in a charge/opt-in you did not choose | pre-checked insurance |
| `benign` | **everything else** — and most rows are this | "Returns", "Laptops", "Red" |

Not dark just because it mentions a number, a deadline or a discount. Legitimate
commerce does all three constantly. A **settled, verifiable total** is benign; a
**stated real deadline** is benign; an ordinary advertised discount is benign.

Multi-label is allowed and expected: *"Only 3 left — ends in 10:00"* is
`scarcity false_urgency`.

#### Doing it

Fill the `gold_labels` column. Space-separated labels for a finding
(`scarcity false_urgency`), or the literal word `benign` for none. Use `notes` for
anything you were unsure about — those rows are the interesting ones later.

**Annotate before looking at `model_labels`.** It is deliberately the second-to-last
column for that reason. Reading it first turns the exercise into measuring your
agreement with the model instead of measuring the model, and the resulting number is
worthless while looking respectable.

**Sort by `text` before you start.** Real pages repeat the same pattern with only a
number changing -- "48 sold", "25 sold", "10 sold" -- and sorting groups them so one
decision fills twenty rows. Row order does not matter to `gold-eval`, which reads each
row independently.

Hide the `model_labels`, `rule_hits`, `id` and `url` columns while working. They are
there for later, and `model_labels` in particular will bias you if it stays in view.

**Open it in Google Sheets, or a text editor.** Excel mangles UTF-8 CSV on some
systems, which silently destroys any Devanagari text, and it likes to autocorrect
cell contents. If you must use Excel, import explicitly as UTF-8 rather than
double-clicking the file, and check a Devanagari row still reads correctly before
committing hours of work.

Save as `data/gold/gold.csv` when done.

### 4. Score

```bash
make gold-eval
```

Also writes `data/gold/errors.csv`: every false positive and false negative as its
own row, with an empty `error_category` column to fill in. That is what the Stage 4
"categorise 30 FPs and 30 FNs" criterion needs -- aggregate precision tells you how
many were wrong, never which ones.

Errors are computed against **model + rules**, i.e. what the user actually sees. An
error the product never surfaces is not worth an annotator's time.

Prints per-class precision/recall/F1, macro-F1 over the seven dark classes, and a
per-language breakdown — **twice**: model alone, and model plus the rule layer that
actually ships. The difference between them is the rule ablation that
`docs/STAGES.md` asks for.

### 5. Where the output lives

Nothing is written to a dashboard; everything is files and console output.

| What | Where | Contents |
|---|---|---|
| The labelled set | `data/gold/gold.csv` | your annotations, one row per snippet |
| Per-row errors | `data/gold/errors.csv` | every FP and FN, with an empty `error_category` to fill in |
| The scores | stdout from `make gold-eval` | per-class P/R/F1, macro-F1, per-language, rule ablation |
| The write-up | `docs/RESULTS.md` §6 and §7 | the numbers turned into prose, with caveats |

`make gold-eval` prints and does not save its tables, so capture them if you want a
record:

```bash
make gold-eval | tee data/gold/eval-$(date +%F).txt
```

`docs/RESULTS.md` is the deliverable. The CSVs are working files; the write-up is what
a supervisor reads, and it is where the numbers have to be stated with their
limitations attached.

### A note on the committed `gold.csv`

The set currently in `data/gold/` was **annotated by an LLM**, not a human, because
annotation time was unavailable. It is a **silver set** and `docs/RESULTS.md` §6 says
so prominently. If you replace it with human labels, that section's health warning
should come out and the numbers should be re-run — a human-labelled set of even 100
rows is worth more than the 400 in there now.

### Re-running after changing a rule

`gold_eval` re-runs the **model** over your texts, but the `rule_hits` column is
whatever the extension recorded when the page was captured. After changing a rule,
that column is stale.

For a pure text-pattern rule you can re-derive the column offline. For a rule that
inspects live DOM — `prechecked_optin`, `hidden_optout`, `cta_asymmetry` — you must
**re-capture the pages**, because checkbox state and computed contrast do not survive
into the trace.

---

The model is re-run over the gold texts rather than reusing the `model_labels`
recorded at capture time, because those came from whatever bundle and thresholds were
live when the page was scanned. Scoring against them would quietly measure a past
configuration.

### A disagreement to expect

`"958 sold"` was flagged **scarcity** by the model on a real Daraz capture. By the
test at the top of this document a completed sale count is a *settled, verifiable
aggregate* — benign, or at most social_proof. If that judgement holds across the gold
set, it is a systematic false positive worth reporting per class rather than
smoothing over.

### make gold-eval prints and doesn't save, so capture it if you want a record:
make gold-eval | tee data/gold/eval-$(date +%F).txt