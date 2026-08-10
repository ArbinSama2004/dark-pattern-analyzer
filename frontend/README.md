# `frontend/` -- Stage 3

**Delivered and verified** on live Amazon and Daraz pages against a running
backend. See `docs/STAGES.md` for exit criteria and `docs/PROGRESS.md` for the
bugs found doing that verification -- several were only visible on real pages.

Chrome extension (Manifest V3) built with WXT + React + TypeScript + Tailwind +
shadcn/ui.

## Layout

```
frontend/
  wxt.config.ts
  src/
    entrypoints/
      content.ts        # extraction + MutationObserver + local rules
      background.ts     # batching, dedupe, retry, session cache
      sidepanel/        # React: grouped findings, page score, explanations
      popup/            # scan/overlay toggles, side-panel preference
    lib/
      extract/          # TreeWalker, shadow DOM, same-origin iframes
      rules/            # the 11 deterministic detectors
      api/              # typed clients for classify, explain, traces
      resolve.ts        # prediction -> live DOM element, refusing to guess
      merge.ts          # rule + model merge policy
      settings.ts       # persisted user settings
      hash.ts           # occurrence id and model cache key
    ui/                 # shadow-root-isolated overlay components
  scripts/
    generate-icons.py   # regenerates src/public/icon/*.png
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

A third, learned the hard way on Daraz: **a content script is injected once per
document, not once per navigation.** On an SPA an in-page route change replaces the
DOM but leaves this script and everything it has accumulated, so state must be
scoped to a document URL and reset when that changes. See `docs/PROGRESS.md`,
Stage 3.

## Prerequisite

The backend must be running with the real bundle before this extension does
anything useful:

```bash
make smoke-backend    # must print scarcity=0.626
make dev              # API on :8000
```

Then `make ext` here, and load `frontend/.output/chrome-mv3` unpacked at
`chrome://extensions`.

**Always open a fresh tab after reloading the extension.** Reloading does not
replace a content script already injected into an open tab; the stale one keeps
running and reports "Extension context invalidated", which looks like a code bug
and is not.
