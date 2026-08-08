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
