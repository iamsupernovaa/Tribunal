# Tribunal

Two AIs deliberate. One answer.

A chat app where two models independently answer, critique each other, then a judge model merges the best result — including downloadable multi-file code. Mix providers freely: Gemini, OpenAI (GPT), and Anthropic (Claude). Attach files as input; get files back.

## Run locally
```
npm install
npm run dev
```
Open http://localhost:3000 → **Settings** → paste keys for the providers you use, pick a provider + model for Model A, Model B, and Judge.

## Deploy
Push to GitHub, import the repo on Vercel. No config needed.

## How it works
1. Models A and B each draft an answer (and any files), in parallel.
2. Each reviews the other's draft.
3. The judge merges everything into the final answer + files.

Streams live, so you can watch each phase. The "Deliberation" panel shows both drafts and both critiques.

## Setup notes
- Each slot (A / B / Judge) picks its own provider and model. Default: A = Gemini flash, B = GPT, Judge = Gemini flash.
- Keep the **Judge on Gemini (free)** to limit paid API spend — only the two draft+critique calls hit the paid model.
- Keys live in your browser (localStorage) and are sent only to run a turn. Never stored server-side.
- All providers are called server-side via `/api/chat` (avoids browser CORS).

### Model strings
- Gemini (free-tier): `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-flash-preview`
- OpenAI: e.g. `gpt-5.5` (paid — needs billing on console)
- Anthropic: e.g. `claude-sonnet-4-6` (paid — needs billing on console)
- NVIDIA (free, build.nvidia.com): e.g. `deepseek-v4-pro`, `diffusiongemma-26b-a4b-it` — uses NVIDIA's OpenAI-compatible endpoint. Text only (image/PDF attachments are skipped for NVIDIA models).
Swap any model string in Settings if one errors.

### Files
Attach text/code (all providers), images (all), or PDFs (Gemini + Claude; GPT shows a placeholder). Generated files appear as cards — download individually or as a `.zip`.

Output is capped per turn (~8K tokens), so very large multi-file projects may truncate; ask for fewer files per turn or use a higher-output model.
