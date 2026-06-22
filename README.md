# Tribunal

Two AIs deliberate. One answer.

A chat app where two models independently answer, review each other to consensus (agreement %, capped rounds), then a judge merges the best result — including downloadable multi-file code. Login with Google/GitHub; chats + projects sync across devices. Mix providers per chat: Gemini, OpenAI (GPT), Anthropic (Claude), NVIDIA.

## Setup

### 1. Database (Neon, free)
1. Create a project at neon.tech.
2. Copy the **pooled** connection string into `DATABASE_URL`.
Tables are created automatically on first use.

### 2. Auth secret
`openssl rand -base64 32` -> `NEXTAUTH_SECRET`.

### 3. Google OAuth
console.cloud.google.com -> APIs & Services -> Credentials -> Create OAuth client ID (Web).
Authorized redirect URI: `{NEXTAUTH_URL}/api/auth/callback/google`
-> `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

### 4. GitHub OAuth
github.com/settings/developers -> New OAuth App.
Authorization callback URL: `{NEXTAUTH_URL}/api/auth/callback/github`
-> `GITHUB_ID`, `GITHUB_SECRET`.

Copy `.env.example` to `.env.local` and fill everything in. (OAuth callback URLs are per-environment — add both your localhost and your Vercel URLs, or make one app per environment.)

## Run locally
```
npm install
npm run dev
```
http://localhost:3000 -> sign in -> open **Settings** (model row) -> pick provider/model and paste keys per model.

## Deploy (Vercel)
Push to GitHub, import on Vercel, add all `.env` vars in Project Settings -> Environment Variables, set `NEXTAUTH_URL` to your Vercel URL. Redeploy.

## How it works
1. Models A and B each draft an answer (and files), in parallel.
2. Each reviews the other and reports an agreement %.
3. They revise; the loop repeats until both >=98% with no remaining corrections (max 3 rounds / 45s).
4. The judge merges the two final answers into one deliverable + files.
The final message shows consensus, round count, agreement %, and seconds.

## Notes
- **API keys stay in your browser** (localStorage) and are sent per-request only. They are never written to the database. On a new device you re-enter keys (chats/projects still sync).
- Chats, projects, titles, messages, and per-chat/per-project model choices are stored in your Neon DB, scoped to your login.
- Provider calls run server-side (`/api/chat`) to avoid browser CORS.
- Convergence is capped to fit Vercel's 60s function limit; large tasks stop at the cap and still merge.

### Model strings
Gemini (free): `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-flash-preview` · OpenAI: `gpt-5.5` · Anthropic: `claude-sonnet-4-6` · NVIDIA: e.g. `deepseek-ai/deepseek-r1`. Use a text (not image/diffusion) model in every slot. Swap any string in Settings if one errors.
