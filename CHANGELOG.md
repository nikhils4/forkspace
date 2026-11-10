# Changelog

Each version here is a release. Forkspace shows these notes in Settings when an update is ready.
To cut one: add a section below, then run `npm run release -- <version>`.

## 0.8.0

- A friendlier concept map: each area of tech is an island with a one-line meaning, ideas are bubbles (bigger when you met them more), and lines show what works together
- Hover an idea for a one-sentence peek; click it to read it in full

## 0.7.3

- New versions show up in the sidebar by themselves: Forkspace checks every 15 minutes and tells every open screen right away, and checks again when you come back to it

## 0.7.2

- One circle per thread, above its first card: click it to complete the thread and fade it back
- Concepts opens on the map; the list is now a grid of cards with area filters, and both share a detail panel
- Updating no longer shows "disconnected": every screen says it's updating and comes back on its own

## 0.7.1

- Concepts is a full page now, opened from the top of the sidebar (Esc or a board takes you back)

## 0.7.0

- Mark a step complete: click the circle at the top of a finished card. It fills with a green tick and every card after it fades back
- Website: the big statement lights up as you scroll in dark mode too

## 0.6.0

- Concepts are never repeated: each idea has one name across all your boards, and the same idea seen again links to it
- Concept map: your concepts grouped by where they belong in tech, with the links between them and where you learned each one
- The library shows each concept once, with every step it came up in

## 0.5.1

- Explain this step (right-click a card) now shows it's working and opens the explanation when it's ready

## 0.5.0

- Away mode is now a full screen: a calm moving wallpaper, the time, what your agents are doing, and a welcome back summary
- Bringing your phone along is one step at a time, right on the away screen
- Opening Forkspace while away mode is on takes you straight to the away screen
- Settings is tidier: General, Phone, Away, Updates and Help

## 0.4.0

- Away mode: keeps your computer awake while you're gone (Mac, Windows, Linux), with phone setup step by step
- Phones reconnect by themselves after waking up, and get notifications reliably
- Safer imports: damaged or tampered files are refused, Full access never comes in from a file
- A bad message from any device can no longer stop Forkspace
- Deleting a board now cleans up its branch copies
- Updates work cleanly when Forkspace runs in the background
- A broken state file is kept for recovery instead of being replaced
- Many smaller fixes from a full security review

## 0.3.0

- Move to another Mac: export every board, conversation and code branch to one file, then import it anywhere (Settings)

## 0.2.2

- Help and feedback in Settings: report a bug, suggest an idea or ask a question on GitHub, with your version and device filled in
- A crash screen can report itself on GitHub

## 0.2.1

- Deleted the cards from a Claude Code session? It can be brought in again
- Website: clearer search listing, questions answered, better share image

## 0.2.0

- Right-click or long-press anything on the canvas for a menu: reply, branch, explain, copy, recolour, delete
- Boards get a menu too, with Start fresh and Delete board
- Click a card to glide it to the centre; boards open centred
- The coloured line on a card shows only while its agent works
- Updates now come as versions with notes, and never get stuck on local edits
- No more blank screens; Tidy up spacing fixed

## 0.1.0

- Canvas of agents: branch any step, and the code branches with it
- Chat, Canvas and Code views with live diffs and Follow agent
- Concepts explained in plain words while agents work
- Use it on your phone, install it as an app, keep it running in the background
- Bring in your Claude Code sessions
- One-click updates, light and dark themes
