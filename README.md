# Forkspace

**The editor for the age of agents.** Direct Claude Code agents, watch every change land, and learn the concepts behind the code.

![Forkspace Code view: a live diff with a concept explained beside it](site/assets/code-learn.webp)

[Website](https://forkspace-app.netlify.app) · Built by [nikhils4](https://github.com/nikhils4) · MIT

- **Direct.** Every prompt becomes a step on a canvas. Branch from any step and the code branches with it. Run many agents side by side.
- **Review.** See each branch's files with a live diff. Follow the agent as it edits. Approve risky steps right where they happen.
- **Learn.** As agents work, Forkspace explains the concepts behind their code in plain words, using your actual code.

Runs on your machine. Use it from the browser, as an installed app, or from your phone.

## Quick start

You need Node 20+, git, and an Anthropic API key.

```bash
git clone https://github.com/nikhils4/forkspace && cd forkspace
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # from https://console.anthropic.com
npm start                             # builds, then serves http://localhost:4747
```

Then, in **Settings**:

- **Keep running in the background** (macOS): starts Forkspace at login and restarts it if it stops. No terminal needed after this.
- **Install the app** from your browser for its own window and Dock icon.

Forkspace is a third-party app, so it signs in with an API key. Anthropic's terms ask third-party apps not to use Claude.ai logins.

### Updating

When a new version is out, the sidebar shows **Update available**. Open Settings and click **Update and restart**. Forkspace pulls, reinstalls if needed, rebuilds, restarts, and the page reloads itself. It won't update while agents are running or if you have local edits in the Forkspace folder.

By hand: `git pull && npm install && npm start`.

## How it works

- **Board:** one project folder.
- **Step:** one prompt and everything the agent did for it.
- **Reply** to the latest step to continue. **Branch** from any earlier step to try another idea. The agent remembers the conversation up to that step and nothing after it.
- **Notes:** double-click the canvas (or press `n`). Drag between dots to link anything.

### Three views

| View | What it's for |
|---|---|
| **Chat** | Any branch as a conversation. Tap a branch point to switch. |
| **Canvas** | Every step and branch on one map, with your notes. **Tidy up** arranges it; zoom out for titles only. |
| **Code** | The branch's files and a live diff of everything the agents changed. **Follow agent** opens each file as it's edited. |

Switching views keeps your place. Press `⌘K` to jump to any board, branch, file or action.

### Concepts

While an agent works, a small, fast model (no tools) reads what it did and writes one concept at a time: a short plain-language explanation with the real code behind it. For example, *"Memoization: remembering past answers"* when an agent adds a cache.

- Concepts appear beside the code, in the chat, and on canvas cards.
- **Explain** any step or file on demand.
- Every concept is saved to your **Concepts** library.

Turn it off per board with the **Learn** pill in the top bar.

### Branching the code, not just the chat

With **Separate copy per branch** (the default for git repos):

1. Each branch works in its own git worktree under `~/.forkspace/worktrees/`, on a branch named `forkspace/<id>`.
2. After every step, Forkspace commits that worktree. The commit is the step's checkpoint.
3. Branching from a step starts a new worktree at its checkpoint, so the branch sees the code exactly as it was then.

Branches never overwrite each other. To keep a result, merge its `forkspace/<id>` branch like any other. A step's **Details** panel shows the branch, folder and diff, plus a command to continue from that exact point in your terminal.

**Same folder** mode works without git, but every agent edits the same files. Agents start from your last commit, so commit anything they need first.

### Bring in your Claude Code sessions

Already worked in this folder with the Claude Code extension or CLI? When you create a board, Forkspace offers to bring those sessions in (or use **Bring in Claude Code sessions** from the branch list or `⌘K`). Each prompt becomes a step you can continue or branch from.

- Continuing runs in your real folder, just like the original session.
- Branching starts from a snapshot of the folder as it is now, including uncommitted work. Your checkout and git staging are never touched.

## On your phone

Agents always run on your Mac. Your phone is a remote control.

1. Install [Tailscale](https://tailscale.com/download) on your Mac and phone, signed in to the same account.
2. In Forkspace, open **Settings**, find **Use Forkspace on your phone**, and turn it on. This serves Forkspace over HTTPS to your own devices only.
3. Scan the QR code with your phone, or open the address and type the 6-digit code.
4. On iPhone: Share, then **Add to Home Screen**, and pair from the installed app.

Turn on **Notifications** per device to get a ping when an agent needs you or finishes. On the phone you get Chat, Canvas and Code views, an **Agents** tab with Allow and Deny, and your Concepts.

Any other HTTPS tunnel works too: set its address in Settings.

## Permissions

Pick per board, change any time.

| Mode | Behaviour |
|---|---|
| Ask me | Risky steps wait for Allow, Always or Deny |
| Accept edits | File edits run on their own; commands still ask |
| Auto | Safe steps run; unsure ones ask |
| Plan only | Reads and plans, changes nothing |
| Full access | Never asks. Only for throwaway folders. |

Anything waiting on you glows amber, shows under **Agents** in the sidebar, and adds a count to the tab title.

## Shortcuts

| Key | Action |
|---|---|
| `Enter` | Send (`Shift+Enter` for a new line) |
| `/` or `r` | Focus the message box |
| `⌘K` or `⌘P` | Search boards, branches, files and actions |
| `1` `2` `3` | Chat, Canvas, Code |
| `Esc` | Start a new thread instead of replying |
| `n` | New note |
| `Backspace` | Delete selected steps (and their branches) or notes |
| Double-click a step | Open details |
| Right-click (long-press on a phone) | Menu for a step, note or empty canvas: reply, branch, explain, copy, recolour, delete |
| Right-click a board, or its `···` | Board settings, **Start fresh** (clear every card, keep the board), Delete board |

## Settings

In the app: **Appearance** (System, Light, Dark; also the sun and moon button in the sidebar), phone access and pairing, notifications, background mode, updates, and **Sign out others**.

Environment variables:

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Required |
| `PORT` | `4747` | |
| `HOST` | `127.0.0.1` | Keep it on localhost; agents can run commands on this machine |
| `FORKSPACE_HOME` | `~/.forkspace` | State, worktrees and logs |
| `FORKSPACE_EDITOR` | | Editor command for **Open in editor**. Without it, Forkspace tries VS Code, Cursor, then Finder. |
| `FORKSPACE_MENTOR_MODEL` | `haiku` | Model that writes concepts |

## Security

- Every connection needs an access key. Pages on the Mac itself get it automatically. Other devices pair with a 6-digit code that expires after 5 minutes, and wrong guesses are rate limited.
- A request only counts as local when it reaches the server directly over loopback, with a localhost `Host` header and no proxy headers. This blocks DNS rebinding and tunnelled requests.
- File reads are locked to the board's folder; `../` paths and symlinks that point outside are refused.
- **Sign out others** (Settings) rotates the key, so every paired device has to pair again.
- Keys live in `~/.forkspace/auth.json` and `push.json` (mode 600).

Forkspace runs agents with your user's permissions. Use Tailscale or another private tunnel for remote access; don't expose the port publicly.

## Development

```bash
npm run dev        # server with reload + Vite on http://localhost:5173 (Node 22.18+)
npm run typecheck
npm run build      # client to dist/, server to build/
```

- `server/`: agent runner (Claude Agent SDK), worktrees and checkpoints, concepts, sessions import, updates, auth.
- `client/`: React app (canvas, chat, code view, settings), installable as a PWA.
- `shared/`: types shared by both.
- `site/`: the website.

## Roadmap

- Merge a branch back from the app
- Search across every step and note
- Forkspace Cloud: agents that keep working while your laptop sleeps ([join the waitlist](https://forkspace-app.netlify.app/#cloud))

## License

MIT · Built by [nikhils4](https://github.com/nikhils4)
