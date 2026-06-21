'use client';

import { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';

const PROVIDERS = [
  { id: 'gemini', label: 'Gemini', default: 'gemini-2.5-flash' },
  { id: 'openai', label: 'OpenAI (GPT)', default: 'gpt-5.5' },
  { id: 'anthropic', label: 'Anthropic (Claude)', default: 'claude-sonnet-4-6' },
  { id: 'nvidia', label: 'NVIDIA', default: 'deepseek-v4-pro' },
];
const DEFAULT_MODEL = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.default]));

const DEFAULT_SLOTS = {
  A: { provider: 'nvidia', model: 'deepseek-v4-pro' },
  B: { provider: 'nvidia', model: 'diffusiongemma-26b-a4b-it' },
  judge: { provider: 'nvidia', model: 'deepseek-v4-pro' },
};

const PHASE_LABEL = { draft: 'Drafting', critique: 'Critiquing', verdict: 'Deciding' };

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function readFile(file) {
  const texty =
    /^text\//.test(file.type) ||
    /(json|javascript|xml|csv|markdown|x-sh|x-python)/.test(file.type) ||
    file.type === '' ||
    /\.(txt|md|js|jsx|ts|tsx|py|json|csv|html|css|scss|c|h|cpp|java|go|rs|rb|php|sh|yml|yaml|toml|sql|env|gitignore)$/i.test(file.name);
  return new Promise((resolve) => {
    const reader = new FileReader();
    if (texty) {
      reader.onload = () => resolve({ name: file.name, mimeType: file.type || 'text/plain', kind: 'text', content: reader.result });
      reader.readAsText(file);
    } else {
      reader.onload = () => resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', kind: 'binary', content: String(reader.result).split(',')[1] || '' });
      reader.readAsDataURL(file);
    }
  });
}

export default function Page() {
  const [keys, setKeys] = useState({ gemini: '', openai: '', anthropic: '', nvidia: '' });
  const [slots, setSlots] = useState(DEFAULT_SLOTS);
  const [showSettings, setShowSettings] = useState(false);
  const [cfgError, setCfgError] = useState('');

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState([]);
  const [running, setRunning] = useState(false);

  const scroller = useRef(null);
  const fileInput = useRef(null);

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem('tribunal2') || '{}');
      if (s.keys) setKeys((k) => ({ ...k, ...s.keys }));
      if (s.slots) setSlots((sl) => ({ ...sl, ...s.slots }));
      if (!s.keys?.gemini && !s.keys?.openai && !s.keys?.anthropic && !s.keys?.nvidia) setShowSettings(true);
    } catch {
      setShowSettings(true);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('tribunal2', JSON.stringify({ keys, slots }));
  }, [keys, slots]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages]);

  function setSlot(name, patch) {
    setSlots((s) => ({ ...s, [name]: { ...s[name], ...patch } }));
  }
  function setProvider(name, provider) {
    setSlot(name, { provider, model: DEFAULT_MODEL[provider] });
  }

  function patchAssistant(patch) {
    setMessages((prev) => {
      const n = [...prev];
      for (let i = n.length - 1; i >= 0; i--)
        if (n[i].role === 'assistant') {
          n[i] = typeof patch === 'function' ? patch(n[i]) : { ...n[i], ...patch };
          break;
        }
      return n;
    });
  }

  function handleEvent(ev) {
    if (ev.type === 'phase') patchAssistant({ phase: ev.phase });
    else if (ev.type === 'draft') patchAssistant((m) => ({ ...m, delib: { ...m.delib, ['draft' + ev.side]: ev.text } }));
    else if (ev.type === 'critique') patchAssistant((m) => ({ ...m, delib: { ...m.delib, ['crit' + ev.side]: ev.text } }));
    else if (ev.type === 'verdict') patchAssistant({ content: ev.text });
    else if (ev.type === 'files') patchAssistant({ files: ev.files });
    else if (ev.type === 'error') patchAssistant({ error: ev.message, running: false, phase: '' });
  }

  async function onPick(e) {
    const files = Array.from(e.target.files || []);
    const read = await Promise.all(files.map(readFile));
    setPending((p) => [...p, ...read]);
    e.target.value = '';
  }

  function missingKeys() {
    const used = new Set([slots.A.provider, slots.B.provider, slots.judge.provider]);
    return [...used].filter((p) => !keys[p]);
  }

  async function send() {
    const text = input.trim();
    if ((!text && pending.length === 0) || running) return;

    const miss = missingKeys();
    if (miss.length) {
      setShowSettings(true);
      setCfgError('Add API key(s) for: ' + miss.join(', '));
      return;
    }
    setCfgError('');

    const attachments = pending;
    const userMsg = { role: 'user', content: text, files: attachments.map((a) => ({ path: a.name })) };
    const apiMessages = [
      ...messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content || '' })),
      { role: 'user', content: text },
    ];

    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '', files: [], delib: {}, phase: 'draft', running: true }]);
    setInput('');
    setPending([]);
    setRunning(true);

    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys, slots, messages: apiMessages, attachments }),
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
      patchAssistant({ error: String(e?.message || e) });
    } finally {
      patchAssistant({ running: false, phase: '' });
      setRunning(false);
    }
  }

  async function downloadZip(files) {
    const zip = new JSZip();
    files.forEach((f) => zip.file(f.path, f.content));
    const blob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(blob, 'tribunal-files.zip');
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="mark">⚖</span> Tribunal
          <span className="tag">two AIs deliberate · one answer</span>
        </div>
        <button className="link" onClick={() => setShowSettings((s) => !s)}>{showSettings ? 'Hide' : 'Settings'}</button>
      </header>

      {showSettings && (
        <section className="settings">
          <div className="keys">
            <label>Gemini key<input type="password" value={keys.gemini} onChange={(e) => setKeys((k) => ({ ...k, gemini: e.target.value }))} placeholder="AIza..." autoComplete="off" /></label>
            <label>OpenAI key<input type="password" value={keys.openai} onChange={(e) => setKeys((k) => ({ ...k, openai: e.target.value }))} placeholder="sk-proj-..." autoComplete="off" /></label>
            <label>Anthropic key<input type="password" value={keys.anthropic} onChange={(e) => setKeys((k) => ({ ...k, anthropic: e.target.value }))} placeholder="sk-ant-..." autoComplete="off" /></label>
            <label>NVIDIA key<input type="password" value={keys.nvidia} onChange={(e) => setKeys((k) => ({ ...k, nvidia: e.target.value }))} placeholder="nvapi-..." autoComplete="off" /></label>
          </div>
          <div className="slots">
            <SlotRow name="Model A" slot={slots.A} onProvider={(p) => setProvider('A', p)} onModel={(v) => setSlot('A', { model: v })} />
            <SlotRow name="Model B" slot={slots.B} onProvider={(p) => setProvider('B', p)} onModel={(v) => setSlot('B', { model: v })} />
            <SlotRow name="Judge" slot={slots.judge} onProvider={(p) => setProvider('judge', p)} onModel={(v) => setSlot('judge', { model: v })} />
          </div>
          {cfgError && <div className="error">{cfgError}</div>}
          <p className="hint">Only fill the keys for providers you use. Keys stay in your browser and are sent only to run a turn. Tip: keep Judge on Gemini (free) to limit paid usage.</p>
        </section>
      )}

      <div className="messages" ref={scroller}>
        {messages.length === 0 && (
          <div className="empty">
            <p>Ask anything, or attach files.</p>
            <p className="dim">Two models answer, review each other, and return the best result — including downloadable code files.</p>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="msg user">
              <div className="bubble">
                {m.content}
                {m.files?.length > 0 && (
                  <div className="chips">{m.files.map((f, j) => (<span key={j} className="chip">📎 {f.path}</span>))}</div>
                )}
              </div>
            </div>
          ) : (
            <div key={i} className="msg bot">
              <div className="bubble">
                {m.running && <Phase phase={m.phase} />}
                {(m.delib?.draftA || m.delib?.draftB) && (
                  <details className="delib">
                    <summary>Deliberation</summary>
                    <div className="delib-grid">
                      <Panel label="Model A · draft" text={m.delib.draftA} />
                      <Panel label="Model B · draft" text={m.delib.draftB} />
                      <Panel label="A reviews B" text={m.delib.critA} />
                      <Panel label="B reviews A" text={m.delib.critB} />
                    </div>
                  </details>
                )}
                {m.content && <div className="prose">{m.content}</div>}
                {m.files?.length > 0 && (
                  <div className="files">
                    <div className="files-head">
                      <span>{m.files.length} file{m.files.length > 1 ? 's' : ''}</span>
                      <button className="mini" onClick={() => downloadZip(m.files)}>Download all .zip</button>
                    </div>
                    {m.files.map((f, j) => (<FileCard key={j} file={f} />))}
                  </div>
                )}
                {m.error && <div className="error">{m.error}</div>}
              </div>
            </div>
          )
        )}
      </div>

      <div className="composer">
        {pending.length > 0 && (
          <div className="chips top">
            {pending.map((a, i) => (
              <span key={i} className="chip">📎 {a.name}<button onClick={() => setPending((p) => p.filter((_, k) => k !== i))}>×</button></span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button className="attach" onClick={() => fileInput.current?.click()} title="Attach files">＋</button>
          <input ref={fileInput} type="file" multiple hidden onChange={onPick} />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message Tribunal…"
            rows={1}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <button className="send" onClick={send} disabled={running}>{running ? '…' : '↑'}</button>
        </div>
      </div>
    </div>
  );
}

function SlotRow({ name, slot, onProvider, onModel }) {
  return (
    <div className="slot">
      <span className="slot-name">{name}</span>
      <select value={slot.provider} onChange={(e) => onProvider(e.target.value)}>
        {PROVIDERS.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
      </select>
      <input value={slot.model} onChange={(e) => onModel(e.target.value)} />
    </div>
  );
}

function Phase({ phase }) {
  const steps = ['draft', 'critique', 'verdict'];
  const idx = steps.indexOf(phase);
  return (
    <div className="phase">
      <span className="spinner" />
      {steps.map((s, i) => (<span key={s} className={'pstep' + (i === idx ? ' on' : '') + (idx > i ? ' done' : '')}>{PHASE_LABEL[s]}</span>))}
    </div>
  );
}

function Panel({ label, text }) {
  return (
    <div className="panel">
      <div className="panel-label">{label}</div>
      <div className="panel-body">{text || <span className="dim">…</span>}</div>
    </div>
  );
}

function FileCard({ file }) {
  const [open, setOpen] = useState(false);
  function dl() {
    const blob = new Blob([file.content], { type: 'text/plain' });
    triggerDownload(blob, file.path.split('/').pop());
  }
  return (
    <div className="file">
      <div className="file-head">
        <button className="file-name" onClick={() => setOpen((o) => !o)}><span className="caret">{open ? '▾' : '▸'}</span> {file.path}</button>
        <button className="mini" onClick={dl}>Download</button>
      </div>
      {open && <pre className="code">{file.content}</pre>}
    </div>
  );
}
