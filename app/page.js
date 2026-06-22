'use client';

import { useState, useEffect, useRef } from 'react';
import { useSession, signIn, signOut } from 'next-auth/react';
import JSZip from 'jszip';

const PROVIDERS = [
  { id: 'gemini', label: 'Gemini', default: 'gemini-2.5-flash' },
  { id: 'openai', label: 'OpenAI (GPT)', default: 'gpt-5.5' },
  { id: 'anthropic', label: 'Anthropic (Claude)', default: 'claude-sonnet-4-6' },
  { id: 'nvidia', label: 'NVIDIA', default: 'deepseek-ai/deepseek-r1' },
];
const DEFAULT_MODEL = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.default]));

const DEFAULT_SLOTS = {
  A: { provider: 'nvidia', model: 'deepseek-ai/deepseek-r1', key: '' },
  B: { provider: 'gemini', model: 'gemini-2.5-flash', key: '' },
  judge: { provider: 'gemini', model: 'gemini-2.5-flash', key: '' },
};

const PHASE_LABEL = { draft: 'Drafting', review: 'Reviewing', revise: 'Revising', verdict: 'Merging' };
const KEYS_LS = 'tribunal_keys';
const SLOT_NAMES = ['A', 'B', 'judge'];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---- client-only keychain (keys never go to the server) ---- */
const loadKeychain = () => { try { return JSON.parse(localStorage.getItem(KEYS_LS) || '{}'); } catch { return {}; } };
const saveKeychain = (kc) => localStorage.setItem(KEYS_LS, JSON.stringify(kc));
function setKey(chatId, slot, key) { const kc = loadKeychain(); kc[chatId] = { ...(kc[chatId] || {}), [slot]: key }; saveKeychain(kc); }
function keysOf(chatId) { return loadKeychain()[chatId] || {}; }
function overlayKeys(slots, keys) {
  const out = {};
  for (const n of SLOT_NAMES) out[n] = { ...(slots?.[n] || DEFAULT_SLOTS[n]), key: keys?.[n] || '' };
  return out;
}
const stripKeys = (slots) => ({
  A: { provider: slots.A.provider, model: slots.A.model },
  B: { provider: slots.B.provider, model: slots.B.model },
  judge: { provider: slots.judge.provider, model: slots.judge.model },
});

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
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

function blankChat(projectId, slots) {
  return { id: uid(), projectId: projectId || null, title: 'New chat', slots: clone(slots || DEFAULT_SLOTS), messages: [] };
}
function serializeMessages(msgs) {
  return msgs.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: m.content, files: m.files }
      : { role: 'assistant', content: m.content, files: m.files, stats: m.stats, error: m.error }
  );
}

/* ---- server sync helpers ---- */
const api = (action, body) => fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }) }).catch(() => {});
const saveChatServer = (c) => api('upsertChat', { chat: { id: c.id, projectId: c.projectId, title: c.title, slots: stripKeys(c.slots), messages: serializeMessages(c.messages) } });
const saveProjectServer = (p) => api('upsertProject', { project: { id: p.id, name: p.name, slots: p.slots || null } });

export default function Page() {
  const { data: session, status } = useSession();

  const [store, setStore] = useState({ projects: [], chats: [], activeId: null });
  const [hydrated, setHydrated] = useState(false);
  const [editing, setEditing] = useState(null);
  const [cfgError, setCfgError] = useState('');
  const [sidebar, setSidebar] = useState(false);

  const [input, setInput] = useState('');
  const [pending, setPending] = useState([]);
  const [running, setRunning] = useState(false);

  const scroller = useRef(null);
  const fileInput = useRef(null);
  const saveTimer = useRef(null);

  // load data from server once signed in
  useEffect(() => {
    if (status !== 'authenticated' || hydrated) return;
    (async () => {
      let projects = [], chats = [];
      try {
        const r = await fetch('/api/data');
        if (r.ok) { const d = await r.json(); projects = d.projects || []; chats = d.chats || []; }
      } catch {}
      chats = chats.map((c) => ({ ...c, slots: overlayKeys(c.slots, keysOf(c.id)), messages: c.messages || [] }));
      if (chats.length === 0) { const c = blankChat(null, DEFAULT_SLOTS); chats = [c]; saveChatServer(c); }
      setStore({ projects, chats, activeId: chats[0].id });
      setHydrated(true);
    })();
  }, [status, hydrated]);

  // debounced save of the active chat
  useEffect(() => {
    if (!hydrated) return;
    const c = store.chats.find((x) => x.id === store.activeId);
    if (!c) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveChatServer(c), 1000);
  }, [store, hydrated]);

  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [store]);

  const activeChat = store.chats.find((c) => c.id === store.activeId) || null;
  const updateChat = (id, fn) => setStore((s) => ({ ...s, chats: s.chats.map((c) => (c.id === id ? fn(c) : c)) }));

  function newChat(projectId = null) {
    const proj = projectId ? store.projects.find((p) => p.id === projectId) : null;
    const base = (proj && proj.slots) || activeChat?.slots || DEFAULT_SLOTS;
    const c = blankChat(projectId, base);
    if (proj && proj.slots) { const ak = keysOf(activeChat?.id); c.slots = overlayKeys(c.slots, ak); }
    setKey(c.id, 'A', c.slots.A.key); setKey(c.id, 'B', c.slots.B.key); setKey(c.id, 'judge', c.slots.judge.key);
    setStore((s) => ({ ...s, chats: [c, ...s.chats], activeId: c.id }));
    saveChatServer(c);
    setEditing(null); setSidebar(false);
  }
  function deleteChat(id) {
    api('deleteChat', { id });
    setStore((s) => { const chats = s.chats.filter((c) => c.id !== id); return { ...s, chats, activeId: s.activeId === id ? chats[0]?.id || null : s.activeId }; });
  }
  function selectChat(id) { setStore((s) => ({ ...s, activeId: id })); setEditing(null); setSidebar(false); }
  function newProject() {
    const name = (prompt('Project name') || '').trim();
    if (!name) return;
    const p = { id: uid(), name, slots: null };
    setStore((s) => ({ ...s, projects: [...s.projects, p] }));
    saveProjectServer(p);
  }
  function deleteProject(id) {
    api('deleteProject', { id });
    setStore((s) => ({ ...s, projects: s.projects.filter((p) => p.id !== id), chats: s.chats.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)) }));
  }

  function targetSlots() {
    if (!editing) return null;
    if (editing.type === 'chat') return store.chats.find((c) => c.id === editing.id)?.slots || null;
    return store.projects.find((p) => p.id === editing.id)?.slots || DEFAULT_SLOTS;
  }
  function setTargetSlot(name, patch) {
    if (!editing) return;
    if (editing.type === 'chat') {
      updateChat(editing.id, (c) => ({ ...c, slots: { ...c.slots, [name]: { ...c.slots[name], ...patch } } }));
      if ('key' in patch) setKey(editing.id, name, patch.key);
    } else {
      setStore((s) => ({ ...s, projects: s.projects.map((p) => {
        if (p.id !== editing.id) return p;
        const base = p.slots || stripKeys(DEFAULT_SLOTS);
        const np = { ...p, slots: { ...base, [name]: { ...base[name], ...patch } } };
        saveProjectServer(np);
        return np;
      }) }));
    }
  }
  const setTargetProvider = (name, provider) => setTargetSlot(name, { provider, model: DEFAULT_MODEL[provider] });

  const missing = (slots) => [['A', 'Model A'], ['B', 'Model B'], ['judge', 'Judge']].filter(([k]) => !slots[k].key).map(([, l]) => l);

  async function onPick(e) {
    const files = Array.from(e.target.files || []);
    const read = await Promise.all(files.map(readFile));
    setPending((p) => [...p, ...read]);
    e.target.value = '';
  }

  function patchAsstOf(id, patch) {
    updateChat(id, (c) => {
      const msgs = [...c.messages];
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') { msgs[i] = typeof patch === 'function' ? patch(msgs[i]) : { ...msgs[i], ...patch }; break; }
      return { ...c, messages: msgs };
    });
  }

  async function send() {
    const text = input.trim();
    if ((!text && pending.length === 0) || running || !activeChat) return;
    const miss = missing(activeChat.slots);
    if (miss.length) { setEditing({ type: 'chat', id: activeChat.id }); setCfgError('Add an API key for: ' + miss.join(', ')); return; }
    setCfgError('');

    const id = activeChat.id;
    const slots = activeChat.slots;
    const attachments = pending;
    const apiMessages = [...activeChat.messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content || '' })), { role: 'user', content: text }];
    const userMsg = { role: 'user', content: text, files: attachments.map((a) => ({ path: a.name })) };

    updateChat(id, (c) => ({
      ...c,
      title: c.title === 'New chat' ? (text.slice(0, 42) || 'New chat') : c.title,
      messages: [...c.messages, userMsg, { role: 'assistant', content: '', files: [], delib: {}, rounds: [], phase: 'draft', running: true }],
    }));
    setInput(''); setPending([]); setRunning(true);

    const patch = (p) => patchAsstOf(id, p);
    const handle = (ev) => {
      if (ev.type === 'phase') patch({ phase: ev.phase, phaseRound: ev.round });
      else if (ev.type === 'draft') patch((m) => ({ ...m, delib: { ...m.delib, ['draft' + ev.side]: ev.text } }));
      else if (ev.type === 'round') patch((m) => ({ ...m, rounds: [...(m.rounds || []), { n: ev.n, agA: ev.agreementA, agB: ev.agreementB, reviewA: ev.reviewA, reviewB: ev.reviewB, converged: ev.converged }] }));
      else if (ev.type === 'verdict') patch({ content: ev.text });
      else if (ev.type === 'files') patch({ files: ev.files });
      else if (ev.type === 'stats') patch({ stats: { rounds: ev.rounds, agA: ev.agreementA, agB: ev.agreementB, seconds: ev.seconds, converged: ev.converged } });
      else if (ev.type === 'error') patch({ error: ev.message, running: false, phase: '' });
    };

    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slots, messages: apiMessages, attachments }) });
      if (r.status === 401) throw new Error('Session expired — sign in again.');
      if (!r.body) throw new Error('No response stream (' + r.status + ')');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(JSON.parse(line)); }
      }
    } catch (e) {
      patch({ error: String(e?.message || e) });
    } finally {
      patch({ running: false, phase: '' });
      setRunning(false);
    }
  }

  async function downloadZip(files) {
    const zip = new JSZip();
    files.forEach((f) => zip.file(f.path, f.content));
    const blob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(blob, 'tribunal-files.zip');
  }

  /* ---- auth gates ---- */
  if (status === 'loading') return <div className="auth-screen"><div className="spinner big" /></div>;
  if (status === 'unauthenticated')
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-brand"><span className="mark">⚖</span> Tribunal</div>
          <p className="auth-sub">Two AIs deliberate. One answer.</p>
          <button className="auth-btn" onClick={() => signIn('google')}>Continue with Google</button>
          <button className="auth-btn" onClick={() => signIn('github')}>Continue with GitHub</button>
        </div>
      </div>
    );

  const ungrouped = store.chats.filter((c) => !c.projectId);
  const ts = targetSlots();
  const editTitle = editing ? (editing.type === 'project' ? store.projects.find((p) => p.id === editing.id)?.name : (store.chats.find((c) => c.id === editing.id)?.title || 'chat')) : '';

  return (
    <div className="layout">
      <aside className={'sidebar' + (sidebar ? ' open' : '')}>
        <div className="side-brand"><span className="mark">⚖</span> Tribunal</div>
        <button className="new-chat" onClick={() => newChat(null)}>＋ New chat</button>
        <button className="new-proj" onClick={newProject}>＋ New project</button>

        <div className="side-scroll">
          {store.projects.map((p) => (
            <div key={p.id} className="proj">
              <div className="proj-head">
                <span className="proj-name">📁 {p.name}</span>
                <span className="proj-actions">
                  <button title="Project models" onClick={() => { setEditing({ type: 'project', id: p.id }); setSidebar(false); }}>⚙</button>
                  <button title="New chat here" onClick={() => newChat(p.id)}>＋</button>
                  <button title="Delete project" onClick={() => deleteProject(p.id)}>🗑</button>
                </span>
              </div>
              {store.chats.filter((c) => c.projectId === p.id).map((c) => (
                <ChatRow key={c.id} chat={c} active={c.id === store.activeId} onSelect={() => selectChat(c.id)} onDelete={() => deleteChat(c.id)} />
              ))}
            </div>
          ))}

          {ungrouped.length > 0 && <div className="side-label">Chats</div>}
          {ungrouped.map((c) => (
            <ChatRow key={c.id} chat={c} active={c.id === store.activeId} onSelect={() => selectChat(c.id)} onDelete={() => deleteChat(c.id)} />
          ))}
        </div>

        <div className="side-user">
          <span className="user-email">{session?.user?.email}</span>
          <button onClick={() => signOut()}>Sign out</button>
        </div>
      </aside>

      {sidebar && <div className="scrim" onClick={() => setSidebar(false)} />}

      <div className="main">
        <div className="topbar">
          <button className="hamburger" onClick={() => setSidebar((s) => !s)}>☰</button>
          <div className="top-title">{activeChat?.title || 'Tribunal'}</div>
          {activeChat && (
            <button className="models-btn" onClick={() => setEditing(editing?.type === 'chat' ? null : { type: 'chat', id: activeChat.id })}>
              {modelShort(activeChat.slots.A)} ⇄ {modelShort(activeChat.slots.B)} · {modelShort(activeChat.slots.judge)} ⚙
            </button>
          )}
        </div>

        {editing && ts && (
          <section className="settings">
            <div className="edit-head">Models for {editing.type === 'project' ? 'project' : 'chat'}: <b>{editTitle}</b><button className="link" onClick={() => setEditing(null)}>Done</button></div>
            <div className="slots">
              <SlotRow name="Model A" slot={ts.A} noKey={editing.type === 'project'} onProvider={(p) => setTargetProvider('A', p)} onModel={(v) => setTargetSlot('A', { model: v })} onKey={(v) => setTargetSlot('A', { key: v })} />
              <SlotRow name="Model B" slot={ts.B} noKey={editing.type === 'project'} onProvider={(p) => setTargetProvider('B', p)} onModel={(v) => setTargetSlot('B', { model: v })} onKey={(v) => setTargetSlot('B', { key: v })} />
              <SlotRow name="Judge" slot={ts.judge} noKey={editing.type === 'project'} onProvider={(p) => setTargetProvider('judge', p)} onModel={(v) => setTargetSlot('judge', { model: v })} onKey={(v) => setTargetSlot('judge', { key: v })} />
            </div>
            {cfgError && <div className="error">{cfgError}</div>}
            <p className="hint">{editing.type === 'project' ? 'New chats in this project inherit these models (keys are entered per chat and stay on your device).' : 'These models apply to this chat only. Each model has its own key; keys stay in your browser and are never stored on the server.'}</p>
          </section>
        )}

        <div className="messages" ref={scroller}>
          {(!activeChat || activeChat.messages.length === 0) && (
            <div className="empty">
              <p>Ask anything, or attach files.</p>
              <p className="dim">Two models answer, review each other to consensus, then merge into the best result — with downloadable files.</p>
            </div>
          )}
          {activeChat?.messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="msg user">
                <div className="bubble">
                  {m.content}
                  {m.files?.length > 0 && <div className="chips">{m.files.map((f, j) => (<span key={j} className="chip">📎 {f.path}</span>))}</div>}
                </div>
              </div>
            ) : (
              <div key={i} className="msg bot">
                <div className="bubble">
                  {m.running && <Phase phase={m.phase} round={m.phaseRound} />}

                  {(m.delib?.draftA || m.delib?.draftB || m.rounds?.length > 0) && (
                    <details className="delib">
                      <summary>Deliberation{m.rounds?.length ? ` · ${m.rounds.length} round${m.rounds.length > 1 ? 's' : ''}` : ''}</summary>
                      <div className="delib-grid">
                        <Panel label="Model A · draft" text={m.delib?.draftA} />
                        <Panel label="Model B · draft" text={m.delib?.draftB} />
                      </div>
                      {m.rounds?.map((r) => (
                        <div key={r.n} className="round">
                          <div className="round-head">
                            Round {r.n}
                            <span className={'agree' + (r.agA >= 98 ? ' ok' : '')}>A {r.agA}%</span>
                            <span className={'agree' + (r.agB >= 98 ? ' ok' : '')}>B {r.agB}%</span>
                            {r.converged && <span className="conv">✓ consensus</span>}
                          </div>
                          <div className="delib-grid">
                            <Panel label="A reviews B" text={r.reviewA} />
                            <Panel label="B reviews A" text={r.reviewB} />
                          </div>
                        </div>
                      ))}
                    </details>
                  )}

                  {m.stats && (
                    <div className="stats">
                      {m.stats.converged ? '✓ consensus' : 'near-consensus'} · {m.stats.rounds} round{m.stats.rounds > 1 ? 's' : ''} · A {m.stats.agA}% / B {m.stats.agB}% · {m.stats.seconds}s
                    </div>
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
              {pending.map((a, i) => (<span key={i} className="chip">📎 {a.name}<button onClick={() => setPending((p) => p.filter((_, k) => k !== i))}>×</button></span>))}
            </div>
          )}
          <div className="composer-row">
            <button className="attach" onClick={() => fileInput.current?.click()} title="Attach files">＋</button>
            <input ref={fileInput} type="file" multiple hidden onChange={onPick} />
            <textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message Tribunal…" rows={1}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <button className="send" onClick={send} disabled={running}>{running ? '…' : '↑'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function modelShort(slot) {
  const m = (slot.model || '').split('/').pop();
  return m.length > 16 ? m.slice(0, 15) + '…' : m;
}

function ChatRow({ chat, active, onSelect, onDelete }) {
  return (
    <div className={'chat-row' + (active ? ' active' : '')} onClick={onSelect}>
      <span className="chat-title">{chat.title}</span>
      <button className="chat-del" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete">×</button>
    </div>
  );
}

function SlotRow({ name, slot, noKey, onProvider, onModel, onKey }) {
  return (
    <div className="slot">
      <span className="slot-name">{name}</span>
      <select value={slot.provider} onChange={(e) => onProvider(e.target.value)}>
        {PROVIDERS.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
      </select>
      <input className="slot-model" value={slot.model} onChange={(e) => onModel(e.target.value)} placeholder="model" />
      {!noKey && <input className="slot-key" type="password" value={slot.key} onChange={(e) => onKey(e.target.value)} placeholder="API key" autoComplete="off" />}
    </div>
  );
}

function Phase({ phase, round }) {
  const steps = ['draft', 'review', 'verdict'];
  const cur = phase === 'revise' ? 'review' : phase;
  const idx = steps.indexOf(cur);
  return (
    <div className="phase">
      <span className="spinner" />
      <span className="phase-now">{PHASE_LABEL[phase] || 'Working'}{round ? ` (round ${round})` : ''}</span>
      <span className="phase-steps">
        {steps.map((s, i) => (<span key={s} className={'pstep' + (i === idx ? ' on' : '') + (idx > i ? ' done' : '')}>{PHASE_LABEL[s]}</span>))}
      </span>
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
  const dl = () => triggerDownload(new Blob([file.content], { type: 'text/plain' }), file.path.split('/').pop());
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
