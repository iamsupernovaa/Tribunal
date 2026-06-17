# Tribunal

Two AIs argue. One verdict.

GPT and Claude each answer your prompt, critique each other's answer, then a judge model merges everything into one best answer.

## Run locally
```
npm install
npm run dev
```
Open http://localhost:3000, click **Keys & models**, paste your OpenAI + Anthropic keys.

## Deploy
Push to GitHub, import the repo on Vercel. No config needed.

## Notes
- Keys live in your browser (localStorage). They're sent to the serverless route only to run a debate — never stored server-side.
- Both providers block browser CORS, so calls go through `/api/debate` (a serverless proxy).
- If a model name errors, change it in **Keys & models**.

Defaults: GPT `gpt-5.5`, Claude `claude-sonnet-4-6`, judge Claude.
