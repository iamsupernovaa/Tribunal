export const runtime = 'nodejs';
export const maxDuration = 60;

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENAI_BASE = 'https://api.openai.com/v1';
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';

const MAX_ROUNDS = 3;
const AGREE_THRESHOLD = 98;
const TIME_BUDGET_MS = 45000;

/* ---------- provider calls ---------- */

async function callGemini(key, model, systemText, neutral, maxTokens) {
  const contents = neutral.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: m.parts.map(geminiPart) }));
  const r = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: systemText ? { parts: [{ text: systemText }] } : undefined,
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Gemini (${model}): ${j.error?.message || r.status}`);
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error(`Gemini (${model}): empty (${cand?.finishReason || j.promptFeedback?.blockReason || 'unknown'})`);
  return text;
}

async function callOpenAICompat(label, baseUrl, key, model, systemText, neutral) {
  const messages = [];
  if (systemText) messages.push({ role: 'system', content: systemText });
  for (const m of neutral) {
    const role = m.role === 'model' ? 'assistant' : m.role;
    if (role === 'user') messages.push({ role, content: m.parts.map(openaiPart) });
    else messages.push({ role, content: m.parts.map((p) => p.text || '').join('') });
  }
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${label} (${model}): ${j.error?.message || j.detail || r.status}`);
  const text = j.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error(`${label} (${model}): empty response`);
  return text;
}

async function callAnthropic(key, model, systemText, neutral, maxTokens) {
  const messages = neutral.map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.parts.map(anthropicPart) }));
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemText, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic (${model}): ${j.error?.message || r.status}`);
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text) throw new Error(`Anthropic (${model}): empty (${j.stop_reason || 'unknown'})`);
  return text;
}

function callModel(slot, systemText, neutral, maxTokens) {
  const key = slot?.key;
  if (!key) throw new Error(`Missing API key for ${slot?.provider || 'a'} slot`);
  switch (slot.provider) {
    case 'openai': return callOpenAICompat('OpenAI', OPENAI_BASE, key, slot.model, systemText, neutral);
    case 'nvidia': return callOpenAICompat('NVIDIA', NVIDIA_BASE, key, slot.model, systemText, neutral);
    case 'anthropic': return callAnthropic(key, slot.model, systemText, neutral, maxTokens);
    default: return callGemini(key, slot.model, systemText, neutral, maxTokens);
  }
}

const userMsg = (text) => [{ role: 'user', parts: [{ kind: 'text', text }] }];

/* ---------- converters ---------- */

function geminiPart(p) {
  if (p.kind === 'image' || p.kind === 'pdf') return { inline_data: { mime_type: p.mime, data: p.data } };
  return { text: p.text || '' };
}
function openaiPart(p) {
  if (p.kind === 'image') return { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } };
  if (p.kind === 'pdf') return { type: 'text', text: `[PDF "${p.name}" attached — not supported on this model]` };
  return { type: 'text', text: p.text || '' };
}
function anthropicPart(p) {
  if (p.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } };
  if (p.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } };
  return { type: 'text', text: p.text || '' };
}

/* ---------- attachments + files ---------- */

function neutralAttParts(atts) {
  const parts = [];
  for (const a of atts || []) {
    const mime = a.mimeType || '';
    if (a.kind === 'binary' && mime.startsWith('image/')) parts.push({ kind: 'image', mime, data: a.content });
    else if (a.kind === 'binary' && mime === 'application/pdf') parts.push({ kind: 'pdf', mime, data: a.content, name: a.name });
    else {
      let txt = a.content;
      if (a.kind === 'binary') { try { txt = Buffer.from(a.content, 'base64').toString('utf-8'); } catch { txt = '[binary file omitted]'; } }
      parts.push({ kind: 'text', text: `File: ${a.name}\n\`\`\`\n${txt}\n\`\`\`` });
    }
  }
  return parts;
}

function extractFiles(text) {
  const re = /<file\s+path="([^"]+)"\s*>([\s\S]*?)<\/file>/g;
  const files = [];
  let m;
  while ((m = re.exec(text))) files.push({ path: m[1].trim(), content: m[2].replace(/^\n/, '').replace(/\s+$/, '\n') });
  const prose = text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  return { prose, files };
}

// Pull the @@@{...}@@@ agreement verdict out of a review.
function parseVerdict(text) {
  const m = text.match(/@@@\s*(\{[\s\S]*?\})\s*@@@/);
  if (m) {
    try {
      const o = JSON.parse(m[1]);
      return {
        agreement: Math.max(0, Math.min(100, Math.round(Number(o.agreement)) || 0)),
        corrections: o.corrections !== false,
        clean: text.replace(/@@@[\s\S]*?@@@/, '').trim(),
      };
    } catch {}
  }
  return { agreement: 50, corrections: true, clean: text.trim() };
}

const FILE_FORMAT =
  'If your answer includes code or any files, output EACH file wrapped EXACTLY like this:\n<file path="relative/path/name.ext">\n...complete file contents...\n</file>\nGive full, runnable files with no "..." placeholders. Put any explanation as plain text outside the <file> tags.';

const REVIEW_SYS =
  "You are reviewing another engineer's answer to the user's request and comparing it against your own answer. List the concrete corrections, fixes, and additions the other answer still needs — bugs, errors, missing files, gaps. Be specific and brief. Then, on the VERY LAST line, output ONLY your agreement verdict in this exact form with nothing after it:\n" +
  '@@@{"agreement": <integer 0-100: how fully you agree the other answer is correct and complete>, "corrections": <true if it still needs changes, false if you fully accept it as-is>}@@@';

/* ---------- handler ---------- */

export async function POST(req) {
  const { slots, messages, attachments } = await req.json();
  const A = slots?.A, B = slots?.B, J = slots?.judge;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (o) => controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'));
      const t0 = Date.now();
      try {
        if (!A || !B || !J) throw new Error('Models not configured');
        if (!messages?.length) throw new Error('No messages');

        const history = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ kind: 'text', text: m.content || '' }] }));
        const att = neutralAttParts(attachments);
        const last = history[history.length - 1];
        if (last?.role === 'user' && att.length) last.parts.push(...att);
        const ask = messages[messages.length - 1]?.content || '';

        // Phase 1: independent drafts
        emit({ type: 'phase', phase: 'draft' });
        const draftSys = `You are an expert engineer and writer. Answer the user's latest message as well as possible: correct, complete, well-reasoned. ${FILE_FORMAT}`;
        const aP = callModel(A, draftSys, history, 8192).then((t) => { emit({ type: 'draft', side: 'A', text: t }); return t; });
        const bP = callModel(B, draftSys, history, 8192).then((t) => { emit({ type: 'draft', side: 'B', text: t }); return t; });
        let [ansA, ansB] = await Promise.all([aP, bP]);

        // Phase 2: review <-> revise loop until consensus
        let agA = 0, agB = 0, converged = false, rounds = 0;
        const reviseSys = `Improve YOUR answer to the user's request using the reviewer's feedback. Keep what is correct, fix every valid point, and output the complete updated answer. ${FILE_FORMAT}`;

        for (let n = 1; n <= MAX_ROUNDS; n++) {
          rounds = n;
          emit({ type: 'phase', phase: 'review', round: n });
          const rvA = callModel(A, REVIEW_SYS, userMsg(`User request:\n${ask}\n\nYour own answer:\n${ansA}\n\nThe other engineer's answer:\n${ansB}\n\nReview the other engineer's answer:`), 1536).then(parseVerdict);
          const rvB = callModel(B, REVIEW_SYS, userMsg(`User request:\n${ask}\n\nYour own answer:\n${ansB}\n\nThe other engineer's answer:\n${ansA}\n\nReview the other engineer's answer:`), 1536).then(parseVerdict);
          const [pa, pb] = await Promise.all([rvA, rvB]); // pa = A reviewing B, pb = B reviewing A
          agA = pa.agreement; agB = pb.agreement;
          converged = agA >= AGREE_THRESHOLD && agB >= AGREE_THRESHOLD && !pa.corrections && !pb.corrections;
          emit({ type: 'round', n, agreementA: agA, agreementB: agB, reviewA: pa.clean, reviewB: pb.clean, converged });

          if (converged) break;
          if (n === MAX_ROUNDS || Date.now() - t0 > TIME_BUDGET_MS) break;

          emit({ type: 'phase', phase: 'revise', round: n });
          const reA = callModel(A, reviseSys, userMsg(`User request:\n${ask}\n\nYour current answer:\n${ansA}\n\nReviewer feedback on your answer:\n${pb.clean}\n\nYour improved answer:`), 8192);
          const reB = callModel(B, reviseSys, userMsg(`User request:\n${ask}\n\nYour current answer:\n${ansB}\n\nReviewer feedback on your answer:\n${pa.clean}\n\nYour improved answer:`), 8192);
          [ansA, ansB] = await Promise.all([reA, reB]);
        }

        // Phase 3: merge into final deliverable
        emit({ type: 'phase', phase: 'verdict' });
        const verdictSys = `Two engineers (A and B) answered the user's request and reviewed each other to ${converged ? 'consensus' : 'near-consensus'} (agreement A ${agA}%, B ${agB}%). Merge their two answers into the single best FINAL answer for the user: keep all correct content, fix any remaining issues, resolve disagreements on the side of correctness, and remove redundancy. ${FILE_FORMAT} This is the final deliverable.`;
        const verdict = await callModel(J, verdictSys, [{ role: 'user', parts: [{ kind: 'text', text: `User request:\n${ask}\n\n=== Engineer A final answer ===\n${ansA}\n\n=== Engineer B final answer ===\n${ansB}\n\nWrite the merged final answer now.` }, ...att] }], 8192);

        const { prose, files } = extractFiles(verdict);
        emit({ type: 'verdict', text: prose || '(final files below)' });
        if (files.length) emit({ type: 'files', files });
        emit({ type: 'stats', rounds, agreementA: agA, agreementB: agB, seconds: Math.round((Date.now() - t0) / 1000), converged });
        emit({ type: 'done' });
      } catch (e) {
        emit({ type: 'error', message: String(e?.message || e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}
