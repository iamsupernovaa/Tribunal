# Tribunal

Two AIs deliberate. One answer.

A chat app where two Gemini models independently answer, critique each other, then a judge model merges the best result — including downloadable multi-file code. Attach files as input; get files back.

## Run locally
```
npm install
npm run dev
```
Open http://localhost:3000 → **Settings** → paste your Gemini API key.

## Deploy
Push to GitHub, import the repo on Vercel. No config needed.

## How it works
1. Models A and B each draft an answer (and any files).
2. Each reviews the other's draft.
3. The judge merges everything into the final answer + files.

Streams live, so you can watch each phase.

## Notes
- Key lives in your browser (localStorage), sent only to run a turn. Never stored server-side.
- Gemini's API is called server-side via `/api/chat` (avoids browser CORS).
- Free-tier model picks: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-flash-preview`. Swap any name in Settings if it errors. (`gemini-3.1-pro-preview` is paid-only.)
- Attach text/code, images, or PDFs. Generated files appear as cards — download individually or as a `.zip`.
- Output is capped per model (≈8K tokens), so very large multi-file projects may truncate; ask for fewer files per turn or a higher-output model.

Defaults: A `gemini-2.5-flash`, B `gemini-2.5-pro`, judge `gemini-2.5-flash`.
