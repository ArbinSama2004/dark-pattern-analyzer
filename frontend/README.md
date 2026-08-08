# `frontend/` -- Stage 3

**Not yet implemented.** Delivered in Stage 3; see `docs/STAGES.md`.

Chrome extension (Manifest V3) built with WXT + React + TypeScript + Tailwind +
shadcn/ui.

## Planned layout

```
frontend/
  wxt.config.ts
  src/
    entrypoints/
      content.ts        # extraction + MutationObserver + local rules
      background.ts     # batching, dedupe, retry, session cache
      sidepanel/        # React: grouped findings, page score
      popup/            # on/off, host allowlist
    lib/
      extract/          # TreeWalker, shadow DOM, same-origin iframes
      rules/            # the 8 deterministic detectors
      api/              # typed client for POST /v1/classify
      hash.ts           # sha1 dedupe
    ui/                 # shadow-root-isolated overlay components
```

## Why WXT rather than plain Vite

MV3 has several entry points with different execution contexts and lifetimes. WXT
discovers them by directory convention and handles manifest generation, HMR for
content scripts, and cross-browser builds. Hand-rolling that is a week of work with
no relevance to the project's actual contribution.

This is also why the layout is `src/entrypoints/` rather than `src/app/` -- the
latter is a Next.js App Router idiom, and an extension has no router.

## Why the rules live here and not in the backend

Every deterministic detector needs live DOM access:

| Rule | Needs |
|---|---|
| `countdown_timer` | mutation cadence on digit nodes |
| `prechecked_optin` | `input.checked` at first paint |
| `hidden_optout` | computed opacity, font size, contrast |
| `cta_asymmetry` | bounding boxes of both buttons |

None of that survives a trip to the server. Text goes to the model; structure is
decided in the page.

## Two constraints that matter

1. **Debounce the MutationObserver at ~300 ms.** Countdown timers mutate every
   second; an undebounced observer will flood your own API. Timer detection is the
   deliberate exception -- a small dedicated observer counts digit changes locally and
   never sends per tick.
2. **Render the overlay in a closed shadow root** with `all: initial`. Host page CSS
   cannot then break your UI, and your styles cannot break the host page. Verify on at
   least five real sites.

## Prerequisite

Stage 2 complete, with `POST /v1/classify` responding inside the latency budget.
