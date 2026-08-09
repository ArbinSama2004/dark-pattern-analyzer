# Dark Pattern Analyzer — Verified Status & Next-Steps Plan

**Purpose.** This file is the source of truth for project status. It's produced
by directly inspecting repository contents, not by trusting other docs' status
labels (several were previously stale — see history below). Read this first in
any new session, before `docs/STAGES.md` or `HANDOFF.md`.

**Last verified:** 2026-08-09, against `dark-pattern-analyzer.zip` (the merged
integration, not the earlier unmerged `project.zip`).

---

## 0. History, briefly, so nobody re-litigates it

Two earlier zips (`project.zip` alone, and a second upload claimed as
"finalized") were byte-for-byte identical to each other — the frontend source
had never actually been merged into the backend/data repo, despite it existing
in a separate `frontend_stage3_fixed.zip`. That merge has now happened; this
document reflects the merged state. `docs/STAGES.md`, `frontend/README.md`,
and the root `README.md` all previously said Stages 2/3 were "not started"
even after the backend and frontend code were both written — those status
lines have now been corrected in this zip.

---

## 1. Verified status per stage

### Stage 1 — Foundation and Model: **Done**
- Dataset present: `data/synthetic_v2_1/`, 28,450 rows, three languages.
- Training/export code present under `ml/src/ml/`.
- Artifact bundle metadata present: `ml/artifacts/model_v1/{manifest.json,
  label_map.json, thresholds.json, tokenizer/, metrics.json, card.md}`.
- **`model.onnx` itself (~950MB, fp32) is confirmed to exist on the
  developer's machine** — deliberately excluded from zip uploads (too large,
  and gitignored by design per `HANDOFF.md`). It has not been inspected
  directly in this chat; its presence is taken on the developer's word.

### Stage 2 — Backend: **Code complete, integration still unverified**
- All modules present and match the Stage 2 delivery list in `docs/STAGES.md`:
  `core/{bundle,taxonomy,model_input,hashing,logging}.py`, `schemas/classify.py`,
  `services/{inference,postprocess,cache}.py`, `api/v1/{classify,health,router}.py`,
  `main.py`, `Dockerfile`.
- Per `STAGE2_COMPLETE.md`: 30 unit tests pass **without** the model (pure
  logic — thresholds, hashing, cache, validation). Real inference, the
  `scarcity=0.626` smoke check, actual latency, and the HTTP integration tests
  are still **unverified from this chat's perspective** — that verification
  can only happen where `model.onnx` actually sits, i.e. on your machine.
- `backend/.env` (local, not shipped in the zip) currently has
  `DP_CORS_ORIGINS=[]`. The file's own comment says the extension's origin
  needs to be listed there for the extension to call the API. This is a
  config step, not a code gap — but it will silently block the extension
  until set.

### Stage 3 — Frontend: **Code complete, dev build produced, browser test still pending**
- Verified: `Popup.tsx`, `SidePanel.tsx`, `content.ts`, `background.ts`,
  messaging, and rules are all present and wired (confirmed by diff against
  the previously-verified source — byte-identical).
- A `wxt` **dev** build was found at `frontend/.output/chrome-mv3/`
  (manifest.json, background.js, content-scripts/content.js, popup.html,
  sidepanel.html) — this is real evidence a build succeeded, but its CSP
  references `http://localhost:3000`, meaning it's a dev-mode build, not a
  production `wxt build` output. Not shipped in the cleaned zip (build
  artifacts are regenerable, not source).
- **Not yet done:** a real `chrome://extensions` load-unpacked test against a
  running backend, on live pages.

### Stage 4 — Evaluation and Release: **Not started**
- No `data/gold/` annotations beyond the empty directory.
- No real-site results section in `docs/RESULTS.md`.
- No model card, no demo recording.
- Correctly marked "not started" everywhere — no discrepancy here.

---

## 2. Plan to reach a fully verified, working Chrome extension

1. **Place the real model bundle.**
   Confirm `ml/artifacts/model_v1/model.onnx` exists on your machine (you've
   said it does, just excluded from uploads). No action needed if so.

2. **Verify the backend for real.**
   ```bash
   cd backend
   uv sync
   cp .env.example .env   # DP_MODEL_DIR already points at ../ml/artifacts/model_v1
   uv run pytest -q       # should now run every test, not skip the model-dependent ones
   uv run uvicorn app.main:app --port 8000
   curl -s localhost:8000/readyz
   ```
   Confirm the startup log shows `smoke check passed: scarcity=0.626`. If it
   doesn't, stop — the exported model is corrupted, not a backend bug.

3. **Set CORS for the extension.**
   Load the unpacked extension once first to get its `chrome-extension://<id>`
   origin (Chrome assigns this), then add it to `DP_CORS_ORIGINS` in
   `backend/.env` and restart the backend.

4. **Produce a real build and load it.**
   ```bash
   cd frontend
   npm install
   npm run build      # production build, not `npm run dev`
   ```
   Load `frontend/.output/chrome-mv3` as unpacked in `chrome://extensions`.

5. **End-to-end test on live pages, backend running.**
   Visit 5+ real e-commerce-style pages. Confirm: extraction produces
   candidates, overlay renders in a closed shadow root without breaking host
   CSS, popup toggle persists, side-panel findings populate and click-to-scroll
   works, a countdown timer doesn't spam the API. This satisfies Stage 3's
   exit criteria in `docs/STAGES.md`.

6. **Re-verify this document against whatever you upload next**, rather than
   assuming step 1–5 succeeded — I can only confirm what's actually in a zip,
   not what ran on your machine.

7. **Move to Stage 4** once 1–6 hold: collect the real-site gold set (300–500
   annotated snippets), run gold-set evaluation, write the model card, record
   the demo.

---

## 3. What NOT to re-litigate

- Don't retrain or re-export the model. Stage 1 decisions (MuRIL, fp32 over
  int8, three dataset versions max) are closed per `docs/PROGRESS.md`.
- Don't rewrite the popup/side-panel wiring — it's done and verified as wired.
- Don't add Redis, Postgres, or `POST /v1/feedback` — explicitly deferred in
  `docs/STAGES.md`'s "Deferred by design" table, with stated triggers.
- Don't re-merge frontend and backend — that's done in this zip.
