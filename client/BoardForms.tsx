import { useEffect, useState } from 'react';
import { EFFORT_LEVELS, type Board, type EffortLevel, type Isolation, type LearnLevel, type ModelChoice, type PermissionMode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { request, send, useStore } from './store.ts';
import { Segmented, Sheet, Switch } from './ui.tsx';

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

// The models your account can use, asked once per page load.
let modelsCache: Promise<ModelChoice[]> | null = null;
const loadModels = () => (modelsCache ??= request<ModelChoice[]>({ type: 'listModels' }).catch((e) => ((modelsCache = null), Promise.reject(e))));
const family = (m: ModelChoice) => (m.value === 'default' ? 'default' : m.name.split(' ')[0].toLowerCase());

/**
 * Pick the model a board's agents use. The newest of each family (Opus, Sonnet, Haiku, Fable,
 * Mythos…) is shown; older versions fold away under "More versions".
 */
export function ModelPicker({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [error, setError] = useState('');
  const current = value || 'default';
  useEffect(() => {
    loadModels().then(setModels, (e: Error) => setError(e.message));
  }, []);
  if (error) return <span className="field-hint">Couldn't load the model list: {error}</span>;
  if (!models) return <div className="mode-list model-list loading">Loading models…</div>;

  const seen = new Set<string>();
  const main: ModelChoice[] = [];
  const more: ModelChoice[] = [];
  for (const m of models) (seen.has(family(m)) ? more : (seen.add(family(m)), main)).push(m);
  // A model set earlier that isn't in the list any more (or was typed by hand) still shows, selected.
  if (!models.some((m) => m.value === current)) main.push({ value: current, name: current, description: 'Set earlier on this board' });

  const row = (m: ModelChoice) => (
    <button key={m.value} className={`mode-row ${m.value === current ? 'on' : ''}`} onClick={() => onChange(m.value === 'default' ? undefined : m.value)}>
      <span className="radio" />
      <span className="mode-text">
        <b>{m.name}</b>
        {m.description && <span>{m.description}</span>}
      </span>
      {m.resolved && m.resolved !== m.value && m.value !== 'default' && <code className="model-id">{m.resolved}</code>}
    </button>
  );
  return (
    <div className="mode-list model-list">
      {main.map(row)}
      {more.length > 0 && (
        <details className="model-more" open={more.some((m) => m.value === current)}>
          <summary>More versions ({more.length})</summary>
          {more.map(row)}
        </details>
      )}
    </div>
  );
}

const EFFORT: Record<EffortLevel | 'default', { label: string; hint: string }> = {
  default: { label: 'Default', hint: 'The model decides how much to think. A good choice for most boards.' },
  low: { label: 'Low', hint: 'Quickest and cheapest. Fine for small, clear tasks.' },
  medium: { label: 'Medium', hint: 'A little more thought, still quick.' },
  high: { label: 'High', hint: 'Thinks things through. Good for most real work.' },
  xhigh: { label: 'Extra high', hint: 'Extra thinking for tricky changes. Slower and uses more.' },
  max: { label: 'Max', hint: 'Thinks the longest. Slowest, and uses the most of your plan.' },
};

/** How hard the board's model thinks. Only the levels the chosen model accepts are offered. */
export function EffortPicker({ model, value, onChange }: { model?: string; value?: EffortLevel; onChange: (v: EffortLevel | undefined) => void }) {
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  useEffect(() => {
    loadModels().then(setModels, () => setModels([]));
  }, []);
  if (!models) return null;
  const m = models.find((x) => x.value === (model || 'default'));
  // A model not in the list (typed by hand): offer every level.
  const levels = m ? (m.efforts ?? []) : EFFORT_LEVELS;
  if (!levels.length) return <span className="field-hint">{m?.name ?? 'This model'} doesn't take an effort level.</span>;
  const current = value ?? 'default';
  const offered = value && !levels.includes(value);
  return (
    <>
      <Segmented<EffortLevel | 'default'>
        value={current}
        onChange={(v) => onChange(v === 'default' ? undefined : v)}
        options={(['default', ...(offered ? [value!] : []), ...levels] as (EffortLevel | 'default')[]).map((v) => ({ value: v, label: EFFORT[v].label }))}
      />
      <span className="field-hint">{offered ? `${EFFORT[value!].label} isn't offered for ${m?.name ?? 'this model'}; it will use the nearest level it has.` : EFFORT[current].hint}</span>
    </>
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
  const [preview, setPreview] = useState(board.previewUrl ?? '');
  const update = (patch: Partial<Pick<Board, 'name' | 'permissionMode' | 'model' | 'effort' | 'learn' | 'previewUrl'>>) => send({ type: 'updateBoard', id: board.id, patch });
  const learn = { on: board.learn?.on !== false, level: board.learn?.level ?? ('growing' as LearnLevel) };

  return (
    <Sheet title="Board settings" onClose={onClose}>
      <div className="form">
        <div className="field">
          <span className="field-label">Model</span>
          <ModelPicker value={board.model} onChange={(m) => update({ model: m })} />
          <span className="field-hint">Used by every new step on this board. Steps already running keep their model.</span>
        </div>
        <div className="field effort-field">
          <span className="field-label">Effort</span>
          <EffortPicker model={board.model} value={board.effort} onChange={(e) => update({ effort: e })} />
        </div>
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
              <b>Thread notes</b>
              <span>After each step, Claude updates a note at the top of the thread: what changed, how it works with links to the code, and what was decided.</span>
            </div>
            <Switch on={learn.on} onChange={(on) => update({ learn: { ...learn, on } })} />
          </div>
        </div>
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
