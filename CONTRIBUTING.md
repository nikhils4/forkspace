# Contributing to Forkspace

Thanks for helping. Small, focused changes are easiest to review.

## Set up

```bash
git clone https://github.com/nikhils4/forkspace && cd forkspace
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev        # server with reload + Vite on http://localhost:5173 (Node 22.18+)
```

Run Forkspace against a throwaway folder while you work. Agents can edit files and run commands.

## Before you open a pull request

- `npm run typecheck` passes.
- You tried the change in the app: desktop, and phone width if it touches the UI. Check light and dark.
- UI copy is short and plain. No jargon where a simple word works.
- One change per pull request, with a sentence on why.

## Where things live

- `server/`: agent runner (Claude Agent SDK), worktrees and checkpoints, concepts, session import, updates, auth.
- `client/`: React app (canvas, chat, code view, settings).
- `shared/`: types shared by both.
- `site/`: the website.

## Releases

Maintainers add a section to `CHANGELOG.md`, then run `npm run release -- <version>`.
