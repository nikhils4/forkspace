# Forkspace

A canvas control center for Claude Code agents.

Every prompt becomes a card on an infinite canvas. Reply to a card to keep going. Reply to an **earlier** card to fork the conversation from that exact point, and the code forks with it. Run as many agents as you want side by side, approve their tool calls right on the cards, and drop sticky notes anywhere.

```
  [ Add auth ]
       │
  [ Use JWT ]──────────fork──────────┐
       │                             │
  [ Add refresh tokens ]     [ Try sessions instead ]   📝 "sessions felt simpler"
```

## Quick start

Requires Node 20+ and git.

```bash
git clone <this repo> forkspace && cd forkspace
npm install
npm start            # builds and serves http://localhost:4747
```

Auth: set `ANTHROPIC_API_KEY`, or Forkspace uses your existing Claude Code login on this machine.

For development with hot reload: `npm run dev`, then open http://localhost:5173.

## How it works

- **Board** = one project folder. Create one from the sidebar.
- **Card** = one agent turn: your prompt, the agent's output, the tools it ran, files changed, cost.
- **Reply** on the latest card of a branch continues that branch.
- **Fork** on any earlier card starts a new branch from that point. The agent keeps the full conversation up to that card and nothing after it.
- **Notes**: double-click the canvas (or press `n`). Drag from any card's dot to another to draw your own links.

### Forking the code, not just the chat

With **Worktree per branch** (the default for git repos):

1. Each branch runs in its own git worktree under `~/.forkspace/worktrees/`, on a branch named `forkspace/<id>`.
2. After every turn, Forkspace commits the worktree. That commit is the card's checkpoint.
3. Forking from a card creates a new worktree at that card's checkpoint, so the fork sees the code exactly as it was then.

Branches never overwrite each other. To keep a result, merge its `forkspace/<id>` branch like any other git branch. The card's **Open** panel shows the branch, folder, diff, and a command to continue that exact point in your terminal (`claude --resume … --fork-session`).

**Same folder** mode works without git, but every agent edits the same files.

Agents start from your repo's last commit, so uncommitted changes in your main checkout are not included. Commit first if the agent needs them.

## Permissions

Pick per board, change any time:

| Mode | Behaviour |
|---|---|
| Ask me | Risky tool calls wait for Allow / Always / Deny on the card |
| Accept edits | File edits run on their own; commands still ask |
| Auto | A classifier approves safe calls and asks when unsure |
| Plan only | Read and plan, no changes |
| Full access | Never asks. Only for throwaway folders. |

Cards that need you glow amber, show in **Running agents** in the sidebar, and add a count to the tab title.

## Shortcuts

| Key | Action |
|---|---|
| `⌘/Ctrl + Enter` | Send |
| `/` or `r` | Focus the composer |
| `Esc` | Clear the target (next prompt starts a new thread) |
| `n` | New note |
| `Backspace` / `Delete` | Delete selected cards (and everything forked from them) or notes |
| Double-click card | Open details |

## Settings

| Env var | Default | |
|---|---|---|
| `PORT` | `4747` | |
| `HOST` | `127.0.0.1` | Keep it on localhost: agents can run commands on this machine. |
| `FORKSPACE_HOME` | `~/.forkspace` | State and worktrees |
| `FORKSPACE_EDITOR` | `code` | Command for "Open folder in editor" |

## Security

Forkspace runs agents with your user's permissions. The server binds to `127.0.0.1` and only accepts WebSocket connections from localhost pages. Don't expose it to a network.

## Roadmap

- Merge a branch back from the UI
- Search across all cards and notes
- Per-branch cost totals
- Desktop app wrapper (Tauri)

## License

MIT
