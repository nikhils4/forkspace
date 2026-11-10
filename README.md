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

For development with hot reload (Node 22.18+): `npm run dev`, then open http://localhost:5173.

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

## On your phone (and as an app)

Forkspace is an installable web app (PWA). Agents always run on your Mac; phones and other browsers are remote controls.

1. **Install it on the Mac**: in Chrome or Edge, click the install icon in the address bar. In Safari: File → Add to Dock.
2. **Reach it from your phone**: install [Tailscale](https://tailscale.com/download) on the Mac and the phone (same account). In Forkspace, open **Devices & phone** and click **Turn on**. This runs `tailscale serve`, which serves Forkspace over HTTPS to your own devices only.
3. **Pair the phone**: scan the QR code on the Devices page, or open the address on the phone and type the 6-digit code. On iPhone, tap Share → Add to Home Screen, open the app, and pair there (home-screen apps keep their own storage).
4. **Notifications**: turn them on per device in Devices. You get one when an agent needs you or finishes, but only while no Forkspace window is open.

On the phone you get:
- **Chat view**: any branch as a conversation, with branch points you can tap to switch.
- **Agents tab**: everything that needs you, with Allow/Deny right there.
- **Canvas**: the full map, with touch support.

Any other HTTPS tunnel works too. Set its address under Devices → "Set your own address".

### Security model

- Every connection needs an access key. Pages opened on the Mac itself (`http://localhost`) get it automatically. Other devices get it by pairing with a 6-digit code that expires after 5 minutes, and repeated wrong guesses are rate limited.
- A request only counts as "local" when it reaches the server directly over loopback, with a localhost `Host` header and no proxy headers. That rules out DNS rebinding and tunnelled requests.
- **Sign out others** (Devices → Security) rotates the key, so every paired device has to pair again.
- Keys live in `~/.forkspace/auth.json` and `push.json` (mode 600).

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
| `Enter` | Send (`Shift+Enter` for a new line) |
| `/` or `r` | Focus the composer |
| `1` / `2` | Chat view / Canvas view |
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

Forkspace runs agents with your user's permissions. The server binds to `127.0.0.1`. Use Tailscale (or another private tunnel) for remote access rather than exposing the port. See the security model above.

## Roadmap

- Merge a branch back from the UI
- Search across all cards and notes
- Per-branch cost totals
- Desktop app wrapper (Tauri)

## License

MIT
