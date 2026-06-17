export const runtime = 'nodejs';
export const maxDuration = 60;

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/* ---------- provider calls ---------- */

async function callGemini(key, model, systemText, neutral, maxTokens) {
  const contents = neutral.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: m.parts.map(geminiPart),
  }));
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

async function callOpenAI(key, model, systemText, neutral) {
  const messages = [];
  if (systemText) messages.push({ role: 'system', content: systemText });
  for (const m of neutral) {
    const role = m.role === 'model' ? 'assistant' : m.role;
    if (role === 'user') messages.push({ role, content: m.parts.map(openaiPart) });
    else messages.push({ role, content: m.parts.map((p) => p.text || '').join('') });
  }
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI (${model}): ${j.error?.message || r.status}`);
  const text = j.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error(`OpenAI (${model}): empty response`);
  return text;
}

async function callAnthropic(key, model, systemText, neutral, maxTokens) {
  const messages = neutral.map((m) => ({
    role: m.role === 'model' ? 'assistant' : 'user',
    content: m.parts.map(anthropicPart),
  }));
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

function callModel(slot, key, systemText, neutral, maxTokens) {
  if (!key) throw new Error(`Missing API key for ${slot.provider}`);
  if (slot.provider === 'openai') return callOpenAI(key, slot.model, systemText, neutral);
  if (slot.provider === 'anthropic') return callAnthropic(key, slot.model, systemText, neutral, maxTokens);
  return callGemini(key, slot.model, systemText, neutral, maxTokens);
}

/* ---------- neutral part -> provider part converters ---------- */

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

/* ---------- attachments -> neutral parts ---------- */

function neutralAttParts(atts) {
  const parts = [];
  for (const a of atts || []) {
    const mime = a.mimeType || '';
    if (a.kind === 'binary' && mime.startsWith('image/')) parts.push({ kind: 'image', mime, data: a.content });
    else if (a.kind === 'binary' && mime === 'application/pdf') parts.push({ kind: 'pdf', mime, data: a.content, name: a.name });
    else {
      let txt = a.content;
      if (a.kind === 'binary') {
        try { txt = Buffer.from(a.content, 'base64').toString('utf-8'); } catch { txt = '[binary file omitted]'; }
      }
      parts.push({ kind: 'text', text: `File: ${a.name}\n\`\`\`\n${txt}\n\`\`\`` });
    }
  }
  return parts;
}

/* ---------- file extraction ---------- */

function extractFiles(text) {
  const re = /<file\s+path="([^"]+)"\s*>([\s\S]*?)<\/file>/g;
  const files = [];
  let m;
  while ((m = re.exec(text))) {
    files.push({ path: m[1].trim(), content: m[2].replace(/^\n/, '').replace(/\s+$/, '\n') });
  }
  const prose = text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  return { prose, files };
}

const FILE_FORMAT =
  'If your answer includes code or any files, output EACH file wrapped EXACTLY like this:\n<file path="relative/path/name.ext">\n...complete file contents...\n</file>\nGive full, runnable files with no "..." placeholders. Put any explanation as plain text outside the <file> tags.';

/* ---------- handler ---------- */

export async function POST(req) {
  const { keys, slots, messages, attachments } = await req.json();
  const A = slots?.A, B = slots?.B, J = slots?.judge;
  const keyFor = (s) => keys?.[s.provider];
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (o) => controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'));
      try {
        if (!A || !B || !J) throw new Error('Models not configured');
        if (!messages?.length) throw new Error('No messages');

        const history = messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ kind: 'text', text: m.content || '' }],
        }));
        const att = neutralAttParts(attachments);
        const last = history[history.length - 1];
        if (last?.role === 'user' && att.length) last.parts.push(...att);
        const latestUser = messages[messages.length - 1]?.content || '';

        // Phase 1: drafts
        emit({ type: 'phase', phase: 'draft' });
        const draftSys = `You are an expert engineer and writer. Answer the user's latest message as well as possible: correct, complete, well-reasoned. ${FILE_FORMAT}`;
        const aP = callModel(A, keyFor(A), draftSys, history, 8192).then((t) => { emit({ type: 'draft', side: 'A', text: t }); return t; });
        const bP = callModel(B, keyFor(B), draftSys, history, 8192).then((t) => { emit({ type: 'draft', side: 'B', text: t }); return t; });
        const [draftA, draftB] = await Promise.all([aP, bP]);

        // Phase 2: cross critique
        emit({ type: 'phase', phase: 'critique' });
        const critSys = "You are reviewing another engineer's answer (and any files) to the user's request. Find bugs, missing files, broken logic, security issues, and concrete improvements. Be specific and brief. Do not rewrite everything.";
        const caP = callModel(A, keyFor(A), critSys, [{ role: 'user', parts: [{ kind: 'text', text: `User request:\n${latestUser}\n\nOther engineer's answer:\n${draftB}\n\nYour critique:` }] }], 2048)
          .then((t) => { emit({ type: 'critique', side: 'A', text: t }); return t; });
        const cbP = callModel(B, keyFor(B), critSys, [{ role: 'user', parts: [{ kind: 'text', text: `User request:\n${latestUser}\n\nOther engineer's answer:\n${draftA}\n\nYour critique:` }] }], 2048)
          .then((t) => { emit({ type: 'critique', side: 'B', text: t }); return t; });
        const [critA, critB] = await Promise.all([caP, cbP]);

        // Phase 3: verdict
        emit({ type: 'phase', phase: 'verdict' });
        const verdictSys = `Two engineers (A and B) answered the user's request, then critiqued each other. Produce the single best FINAL answer for the user: merge the strengths, fix every valid issue raised, and resolve disagreements on the side of correctness. ${FILE_FORMAT} This is the final deliverable.`;
        const bundleParts = [
          { kind: 'text', text: `User request:\n${latestUser}\n\n=== Engineer A answer ===\n${draftA}\n\n=== Engineer B answer ===\n${draftB}\n\n=== A's critique of B ===\n${critA}\n\n=== B's critique of A ===\n${critB}\n\nWrite the final answer now.` },
          ...att,
        ];
        const verdict = await callModel(J, keyFor(J), verdictSys, [{ role: 'user', parts: bundleParts }], 8192);

        const { prose, files } = extractFiles(verdict);
        emit({ type: 'verdict', text: prose || '(final files below)' });
        if (files.length) emit({ type: 'files', files });
        emit({ type: 'done' });
      } catch (e) {
        emit({ type: 'error', message: String(e?.message || e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
