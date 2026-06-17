export const runtime = 'nodejs';
export const maxDuration = 60;

async function callOpenAI(key, model, messages) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI (${model}): ${j.error?.message || r.status}`);
  return j.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(key, model, system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 2048, system, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic (${model}): ${j.error?.message || r.status}`);
  return j.content?.[0]?.text ?? '';
}

export async function POST(req) {
  const {
    prompt,
    openaiKey,
    anthropicKey,
    openaiModel,
    anthropicModel,
    judge,
  } = await req.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (o) =>
        controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'));
      try {
        if (!prompt) throw new Error('Missing prompt');
        if (!openaiKey) throw new Error('Missing OpenAI key');
        if (!anthropicKey) throw new Error('Missing Anthropic key');

        // --- Phase 1: independent drafts ---
        emit({ type: 'phase', phase: 'draft' });
        const draftSys =
          'You are a careful expert. Answer the user request as well as possible: correct, complete, and well-reasoned.';
        const gptP = callOpenAI(openaiKey, openaiModel, [
          { role: 'system', content: draftSys },
          { role: 'user', content: prompt },
        ]).then((t) => {
          emit({ type: 'draft', side: 'gpt', text: t });
          return t;
        });
        const clP = callAnthropic(anthropicKey, anthropicModel, draftSys, [
          { role: 'user', content: prompt },
        ]).then((t) => {
          emit({ type: 'draft', side: 'claude', text: t });
          return t;
        });
        const [gptDraft, claudeDraft] = await Promise.all([gptP, clP]);

        // --- Phase 2: cross critique ---
        emit({ type: 'phase', phase: 'critique' });
        const critSys =
          "You are reviewing another assistant's answer to the user request. Identify factual errors, gaps, weak reasoning, and concrete improvements. Be specific, honest, and brief. Do not rewrite the whole answer.";
        const gcP = callOpenAI(openaiKey, openaiModel, [
          { role: 'system', content: critSys },
          {
            role: 'user',
            content: `User request:\n${prompt}\n\nOther assistant's answer:\n${claudeDraft}\n\nYour critique:`,
          },
        ]).then((t) => {
          emit({ type: 'critique', side: 'gpt', text: t });
          return t;
        });
        const ccP = callAnthropic(anthropicKey, anthropicModel, critSys, [
          {
            role: 'user',
            content: `User request:\n${prompt}\n\nOther assistant's answer:\n${gptDraft}\n\nYour critique:`,
          },
        ]).then((t) => {
          emit({ type: 'critique', side: 'claude', text: t });
          return t;
        });
        const [gptCrit, claudeCrit] = await Promise.all([gcP, ccP]);

        // --- Phase 3: verdict (one judge synthesizes) ---
        emit({ type: 'phase', phase: 'verdict' });
        const verdictSys =
          'Two assistants (A and B) answered a user request, then each critiqued the other. Using all of it, produce the single best final answer for the user. Merge strengths, fix the issues raised in the critiques, and resolve disagreements on the side of correctness. Output ONLY the final answer, with no meta commentary.';
        const bundle = `User request:\n${prompt}\n\n=== Assistant A (GPT) answer ===\n${gptDraft}\n\n=== Assistant B (Claude) answer ===\n${claudeDraft}\n\n=== A's critique of B ===\n${gptCrit}\n\n=== B's critique of A ===\n${claudeCrit}\n\nFinal answer:`;

        let verdict;
        if (judge === 'gpt') {
          verdict = await callOpenAI(openaiKey, openaiModel, [
            { role: 'system', content: verdictSys },
            { role: 'user', content: bundle },
          ]);
        } else {
          verdict = await callAnthropic(
            anthropicKey,
            anthropicModel,
            verdictSys,
            [{ role: 'user', content: bundle }]
          );
        }
        emit({ type: 'verdict', by: judge === 'gpt' ? 'gpt' : 'claude', text: verdict });
        emit({ type: 'done' });
      } catch (e) {
        emit({ type: 'error', message: String(e?.message || e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
