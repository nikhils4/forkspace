import { useState } from 'react';
import type { Board, Isolation, LearnLevel, PermissionMode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { request, send, useStore } from './store.ts';
import { Sheet, Switch } from './ui.tsx';

export const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask me', hint: 'You approve each risky step' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits run on their own, commands ask' },
  { value: 'auto', label: 'Auto', hint: 'Safe steps run, unsure ones ask' },
  { value: 'plan', label: 'Plan only', hint: 'Reads and plans, changes nothing' },
  { value: 'bypassPermissions', label: 'Full access', hint: 'Never asks. Throwaway folders only' },
];

export function ModePicker({ value, onChange }: { value: PermissionMode; onChange: (m: PermissionMode) => void }) {
  return (
    <div className="mode-list">
      {MODES.map((m) => (
        <button key={m.value} className={`mode-row ${m.value === value ? 'on' : ''} ${m.value === 'bypassPermissions' ? 'danger' : ''}`} onClick={() => onChange(m.value)}>
          <span className="radio" />
          <span className="mode-text">
            <b>{m.label}</b>
            <span>{m.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function NewBoard({ onClose, onCreated }: { onClose: () => void; onCreated: (b: Board) => void }) {
  const { home } = useStore();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [isolation, setIsolation] = useState<Isolation>('worktree');
  const [mode, setMode] = useState<PermissionMode>('acceptEdits');
  const [browse, setBrowse] = useState<{ dir: string; parent: string; entries: string[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const open = (p: string) =>
    request<{ dir: string; parent: string; entries: string[] }>({ type: 'listDir', path: p }).then(
      (r) => {
        setBrowse(r);
        setError('');
      },
      (e) => setError(e.message),
    );

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      onCreated(await request<Board>({ type: 'createBoard', name, cwd, isolation, permissionMode: mode }));
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  };

  return (
    <Sheet title="New board" onClose={onClose}>
      <div className="form">
        <label className="field">
          <span className="field-label">Project folder on your Mac</span>
          <div className="row">
            <input value={cwd} placeholder={`${home || '~'}/code/my-app`} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setCwd(e.target.value)} />
            <button className="btn" onClick={() => open(cwd || home || '~')}>
              <Icon name="folder" size={14} /> Browse
            </button>
          </div>
        </label>
        {browse && (
          <div className="browser">
            <div className="browser-head">
              <button className="icon-btn" onClick={() => open(browse.parent)} aria-label="Up one folder">
                <Icon name="chevronLeft" />
              </button>
              <span className="mono ellipsis">{browse.dir}</span>
              <span className="spacer" />
              <button
                className="btn primary sm"
                onClick={() => {
                  setCwd(browse.dir);
                  setBrowse(null);
                }}
              >
                Use this
              </button>
            </div>
            <div className="browser-list">
              {browse.entries.map((e) => (
                <button key={e} className="browser-item" onClick={() => open(`${browse.dir}/${e}`)}>
                  <Icon name="folder" size={15} /> <span className="ellipsis">{e}</span>
                </button>
              ))}
              {browse.entries.length === 0 && <div className="faint pad">No folders inside</div>}
            </div>
          </div>
        )}
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} placeholder={cwd.split('/').filter(Boolean).pop() || 'My project'} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span className="field-label">Branches and code</span>
          <div className="choice">
            <button className={isolation === 'worktree' ? 'on' : ''} onClick={() => setIsolation('worktree')}>
              <b>
                <Icon name="branch" size={14} /> Separate copy per branch
              </b>
              <span>Each branch works in its own git worktree with a checkpoint after every step. Recommended.</span>
            </button>
            <button className={isolation === 'none' ? 'on' : ''} onClick={() => setIsolation('none')}>
              <b>
                <Icon name="folder" size={14} /> Same folder
              </b>
              <span>Every agent edits the folder directly. Works without git, but branches share files.</span>
            </button>
          </div>
        </div>
        <div className="field">
          <span className="field-label">Permissions</span>
          <ModePicker value={mode} onChange={setMode} />
        </div>
        {error && <div className="error-box">{error}</div>}
        <div className="form-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!cwd.trim() || busy} onClick={create}>
            {busy ? 'Creating…' : 'Create board'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export function BoardSettings({ board, onClose }: { board: Board; onClose: () => void }) {
  const [name, setName] = useState(board.name);
  const [model, setModel] = useState(board.model ?? '');
  const [preview, setPreview] = useState(board.previewUrl ?? '');
  const update = (patch: Partial<Pick<Board, 'name' | 'permissionMode' | 'model' | 'learn' | 'previewUrl'>>) => send({ type: 'updateBoard', id: board.id, patch });
  const learn = { on: board.learn?.on !== false, level: board.learn?.level ?? ('growing' as LearnLevel) };

  return (
    <Sheet title="Board settings" onClose={onClose}>
      <div className="form">
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== board.name && update({ name: name.trim() })} />
        </label>
        <div className="field">
          <span className="field-label">Folder</span>
          <div className="mono readonly">{board.cwd}</div>
          <span className="field-hint">{board.isolation === 'worktree' ? 'Each branch works in its own git worktree.' : 'All agents edit this folder directly.'}</span>
        </div>
        <div className="field">
          <span className="field-label">Permissions</span>
          <ModePicker value={board.permissionMode} onChange={(m) => update({ permissionMode: m })} />
        </div>
        <div className="field learn-field">
          <div className="setting-row">
            <div className="setting-text">
              <b>Learn concepts</b>
              <span>As agents work, learn the concepts behind their code, in plain words.</span>
            </div>
            <Switch on={learn.on} onChange={(on) => update({ learn: { ...learn, on } })} />
          </div>
        </div>
        <label className="field">
          <span className="field-label">Model</span>
          <input
            value={model}
            placeholder="Default (your Claude Code setting)"
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => update({ model: model.trim() || undefined })}
          />
          <span className="field-hint">For example opus, sonnet or haiku. Applies to new steps.</span>
        </label>
        <label className="field">
          <span className="field-label">Your app's address</span>
          <input
            value={preview}
            placeholder="http://localhost:3000"
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            onChange={(e) => setPreview(e.target.value)}
            onBlur={() => preview.trim() !== (board.previewUrl ?? '') && update({ previewUrl: preview.trim() })}
          />
          <span className="field-hint">While your app runs, Forkspace takes a screenshot after each step that changes files, so every thread shows what it built.</span>
        </label>
        <div className="danger-zone">
          <div>
            <b>Start fresh</b>
            <span>Clears every card, note and worktree. Keeps the folder and these settings.</span>
          </div>
          <button
            className="btn"
            onClick={() => {
              if (confirm(`Clear everything on "${board.name}" and start fresh?`)) {
                send({ type: 'clearBoard', id: board.id });
                onClose();
              }
            }}
          >
            <Icon name="refresh" size={14} /> Start fresh
          </button>
        </div>
        <div className="danger-zone">
          <div>
            <b>Delete board</b>
            <span>Removes every card, note and worktree on this board.</span>
          </div>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Delete "${board.name}"? This removes all its cards and worktrees.`)) {
                send({ type: 'deleteBoard', id: board.id });
                onClose();
              }
            }}
          >
            <Icon name="trash" size={14} /> Delete
          </button>
        </div>
      </div>
    </Sheet>
  );
}
