export const runtime = 'nodejs';
export const maxDuration = 60;

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini(apiKey, model, systemText, contents, maxTokens = 8192) {
  const r = await fetch(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: systemText ? { parts: [{ text: systemText }] } : undefined,
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Gemini (${model}): ${j.error?.message || r.status}`);
  const cand = j.candidates?.[0];
  if (!cand) throw new Error(`Gemini (${model}): no output (${j.promptFeedback?.blockReason || 'empty'})`);
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error(`Gemini (${model}): empty (${cand.finishReason || 'unknown'})`);
  return text;
}

// Build Gemini parts from uploaded attachments.
function attachmentParts(atts) {
  const parts = [];
  for (const a of atts || []) {
    const mime = a.mimeType || '';
    if (a.kind === 'binary' && (mime.startsWith('image/') || mime === 'application/pdf')) {
      parts.push({ inline_data: { mime_type: mime, data: a.content } });
    } else {
      let txt = a.content;
      if (a.kind === 'binary') {
        try {
          txt = Buffer.from(a.content, 'base64').toString('utf-8');
        } catch {
          txt = '[binary file omitted]';
        }
      }
      parts.push({ text: `File: ${a.name}\n\`\`\`\n${txt}\n\`\`\`` });
    }
  }
  return parts;
}

// Pull <file path="...">...</file> blocks out of a model answer.
function extractFiles(text) {
  const re = /<file\s+path="([^"]+)"\s*>([\s\S]*?)<\/file>/g;
  const files = [];
  let m;
  while ((m = re.exec(text))) {
    files.push({
      path: m[1].trim(),
      content: m[2].replace(/^\n/, '').replace(/\s+$/, '\n'),
    });
  }
  const prose = text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  return { prose, files };
}

const FILE_FORMAT =
  'If your answer includes code or any files, output EACH file wrapped EXACTLY like this:\n<file path="relative/path/name.ext">\n...complete file contents...\n</file>\nGive full, runnable files with no "..." placeholders. Put any explanation as plain text outside the <file> tags.';

export async function POST(req) {
  const { apiKey, modelA, modelB, judge, messages, attachments } = await req.json();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (o) => controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'));
      try {
        if (!apiKey) throw new Error('Missing Gemini API key');
        if (!messages?.length) throw new Error('No messages');

        // Conversation history for the drafting models.
        const history = messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content || '' }],
        }));
        const last = history[history.length - 1];
        const attParts = attachmentParts(attachments);
        if (last?.role === 'user' && attParts.length) last.parts.push(...attParts);
        const latestUser = messages[messages.length - 1]?.content || '';

        // --- Phase 1: two independent drafts ---
        emit({ type: 'phase', phase: 'draft' });
        const draftSys = `You are an expert engineer and writer. Answer the user's latest message as well as possible: correct, complete, well-reasoned. ${FILE_FORMAT}`;
        const aP = callGemini(apiKey, modelA, draftSys, history).then((t) => {
          emit({ type: 'draft', side: 'A', text: t });
          return t;
        });
        const bP = callGemini(apiKey, modelB, draftSys, history).then((t) => {
          emit({ type: 'draft', side: 'B', text: t });
          return t;
        });
        const [draftA, draftB] = await Promise.all([aP, bP]);

        // --- Phase 2: cross critique ---
        emit({ type: 'phase', phase: 'critique' });
        const critSys =
          "You are reviewing another engineer's answer (and any files) to the user's request. Find bugs, missing files, broken logic, security issues, and concrete improvements. Be specific and brief. Do not rewrite everything.";
        const caP = callGemini(
          apiKey,
          modelA,
          critSys,
          [{ role: 'user', parts: [{ text: `User request:\n${latestUser}\n\nOther engineer's answer:\n${draftB}\n\nYour critique:` }] }],
          2048
        ).then((t) => {
          emit({ type: 'critique', side: 'A', text: t });
          return t;
        });
        const cbP = callGemini(
          apiKey,
          modelB,
          critSys,
          [{ role: 'user', parts: [{ text: `User request:\n${latestUser}\n\nOther engineer's answer:\n${draftA}\n\nYour critique:` }] }],
          2048
        ).then((t) => {
          emit({ type: 'critique', side: 'B', text: t });
          return t;
        });
        const [critA, critB] = await Promise.all([caP, cbP]);

        // --- Phase 3: verdict (judge merges into final deliverable) ---
        emit({ type: 'phase', phase: 'verdict' });
        const verdictSys = `Two engineers (A and B) answered the user's request, then critiqued each other. Produce the single best FINAL answer for the user: merge the strengths, fix every valid issue raised, and resolve disagreements on the side of correctness. ${FILE_FORMAT} This is the final deliverable.`;
        const bundleParts = [
          {
            text: `User request:\n${latestUser}\n\n=== Engineer A answer ===\n${draftA}\n\n=== Engineer B answer ===\n${draftB}\n\n=== A's critique of B ===\n${critA}\n\n=== B's critique of A ===\n${critB}\n\nWrite the final answer now.`,
          },
          ...attParts,
        ];
        const verdict = await callGemini(apiKey, judge, verdictSys, [
          { role: 'user', parts: bundleParts },
        ]);

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
