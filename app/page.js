'use client';

import { useState, useEffect } from 'react';

const DEFAULTS = {
  openaiModel: 'gpt-5.5',
  anthropicModel: 'claude-sonnet-4-6',
  judge: 'claude',
};

const PHASES = ['draft', 'critique', 'verdict'];
const PHASE_LABEL = {
  draft: 'Drafting',
  critique: 'Critiquing',
  verdict: 'Reaching verdict',
};

export default function Page() {
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState(DEFAULTS.openaiModel);
  const [anthropicModel, setAnthropicModel] = useState(DEFAULTS.anthropicModel);
  const [judge, setJudge] = useState(DEFAULTS.judge);

  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const [res, setRes] = useState({
    gptDraft: '',
    claudeDraft: '',
    gptCrit: '',
    claudeCrit: '',
    verdict: '',
    verdictBy: '',
  });

  // load saved keys/models
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem('tribunal') || '{}');
      if (s.openaiKey) setOpenaiKey(s.openaiKey);
      if (s.anthropicKey) setAnthropicKey(s.anthropicKey);
      if (s.openaiModel) setOpenaiModel(s.openaiModel);
      if (s.anthropicModel) setAnthropicModel(s.anthropicModel);
      if (s.judge) setJudge(s.judge);
      if (!s.openaiKey || !s.anthropicKey) setShowSettings(true);
    } catch {
      setShowSettings(true);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      'tribunal',
      JSON.stringify({ openaiKey, anthropicKey, openaiModel, anthropicModel, judge })
    );
  }, [openaiKey, anthropicKey, openaiModel, anthropicModel, judge]);

  function handleEvent(ev) {
    if (ev.type === 'phase') setPhase(ev.phase);
    else if (ev.type === 'draft')
      setRes((r) => ({ ...r, [ev.side === 'gpt' ? 'gptDraft' : 'claudeDraft']: ev.text }));
    else if (ev.type === 'critique')
      setRes((r) => ({ ...r, [ev.side === 'gpt' ? 'gptCrit' : 'claudeCrit']: ev.text }));
    else if (ev.type === 'verdict')
      setRes((r) => ({ ...r, verdict: ev.text, verdictBy: ev.by }));
    else if (ev.type === 'error') setError(ev.message);
  }

  async function run() {
    if (!prompt.trim()) return;
    if (!openaiKey || !anthropicKey) {
      setShowSettings(true);
      setError('Add both API keys first.');
      return;
    }
    setError('');
    setPhase('draft');
    setRunning(true);
    setRes({ gptDraft: '', claudeDraft: '', gptCrit: '', claudeCrit: '', verdict: '', verdictBy: '' });

    try {
      const r = await fetch('/api/debate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, openaiKey, anthropicKey, openaiModel, anthropicModel, judge }),
      });
      if (!r.body) throw new Error('No response stream (' + r.status + ')');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) handleEvent(JSON.parse(line));
        }
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setRunning(false);
      setPhase('');
    }
  }

  const phaseIdx = PHASES.indexOf(phase);

  return (
    <main>
      <header>
        <h1>
          <span className="mark">⚖</span> Tribunal
        </h1>
        <p className="sub">Two AIs argue. One verdict.</p>
        <button className="link" onClick={() => setShowSettings((s) => !s)}>
          {showSettings ? 'Hide keys' : 'Keys & models'}
        </button>
      </header>

      {showSettings && (
        <section className="settings">
          <label>
            OpenAI key
            <input
              type="password"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder="sk-proj-..."
              autoComplete="off"
            />
          </label>
          <label>
            Anthropic key
            <input
              type="password"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder="sk-ant-..."
              autoComplete="off"
            />
          </label>
          <div className="row">
            <label>
              GPT model
              <input value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)} />
            </label>
            <label>
              Claude model
              <input value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)} />
            </label>
            <label>
              Judge
              <select value={judge} onChange={(e) => setJudge(e.target.value)}>
                <option value="claude">Claude</option>
                <option value="gpt">GPT</option>
              </select>
            </label>
          </div>
          <p className="hint">Keys stay in your browser (localStorage) and are sent only to run a debate. If a model name errors, swap it.</p>
        </section>
      )}

      <section className="composer">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask anything. Both models answer, critique each other, then a verdict is reached."
          rows={4}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run();
          }}
        />
        <button className="run" onClick={run} disabled={running}>
          {running ? PHASE_LABEL[phase] || 'Working…' : 'Convene ⌘↵'}
        </button>
      </section>

      {error && <div className="error">{error}</div>}

      {(running || res.gptDraft || res.verdict) && (
        <div className="steps">
          {PHASES.map((p, i) => (
            <div
              key={p}
              className={'step' + (phaseIdx === i ? ' active' : '') + (phaseIdx > i || res.verdict ? ' done' : '')}
            >
              {PHASE_LABEL[p]}
            </div>
          ))}
        </div>
      )}

      {(res.gptDraft || res.claudeDraft) && (
        <section>
          <h2>Drafts</h2>
          <div className="cols">
            <Card label="GPT" tone="gpt" text={res.gptDraft} />
            <Card label="Claude" tone="claude" text={res.claudeDraft} />
          </div>
        </section>
      )}

      {(res.gptCrit || res.claudeCrit) && (
        <section>
          <h2>Critiques</h2>
          <div className="cols">
            <Card label="GPT on Claude" tone="gpt" text={res.gptCrit} />
            <Card label="Claude on GPT" tone="claude" text={res.claudeCrit} />
          </div>
        </section>
      )}

      {res.verdict && (
        <section>
          <h2>Verdict <span className="by">decided by {res.verdictBy === 'gpt' ? 'GPT' : 'Claude'}</span></h2>
          <div className="verdict">{res.verdict}</div>
        </section>
      )}
    </main>
  );
}

function Card({ label, tone, text }) {
  return (
    <div className={'card ' + tone}>
      <div className="card-label">{label}</div>
      <div className="card-body">{text || <span className="ph">…</span>}</div>
    </div>
  );
}
