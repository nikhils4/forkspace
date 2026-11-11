# Changelog

Each version here is a release. Forkspace shows these notes in Settings when an update is ready.
To cut one: add a section below, then run `npm run release -- <version>`.

## 0.17.0

- Working cards glow and pulse in their branch colour, and stay easy to spot at any zoom; they blink on the minimap too
- Select several cards: drag a box on empty canvas, or ⇧/⌘ click. Drag any of them to move them all
- ⌘Z undoes moving cards and notes (and tidy layout); ⇧⌘Z redoes. ⌘A selects everything, ⇧1 fits the board
- Walk a thread with the arrow keys: ↑ the step before, ↓ the next one, ← → other branches. Enter opens details
- The path from a thread's start to the card you're on is drawn bold; the rest steps back
- Pan with two fingers, the scroll wheel, Space + drag or the middle mouse button; pinch or ⌘ scroll zooms
- The details panel follows a new thread as soon as you send it, and closes when you go to Concepts or Notes
- Smoother motion: pages and views ease in, cards lift while dragged, lines ease when the path changes

## 0.16.0

- The details panel has its own message box for the step it shows: type, dictate, paste or drop images and files, and send right from there
- Comments now sit beside the card, joined by a short line. Hover a card and click the + on its edge to add one
- "Add to prompt" on a comment goes to the box you can see: the panel's when it is open

## 0.15.0

- Comments on cards: your own quick notes on any step, as many as you like. Add one from the comment button on the card or by right-clicking it
- Each comment can go straight into your next prompt, be copied, edited (double-click) or deleted; "All to prompt" adds them as a list
- Comments also show in the details panel; they never go to the agent unless you put them in a prompt

## 0.14.1

- Terminal: clicking another card reuses the open terminal if nothing was run in it, instead of adding a new tab
- Dictation is more accurate: it keeps listening through pauses, phrases no longer run together or repeat, and when you stop, misheard words are fixed using your project's file names and recent prompts, with punctuation added and filler removed

## 0.14.0

- Attach images and files to a prompt: the paperclip in the message box, paste, or drag and drop
- Images go to Claude as images; other files (PDFs, logs, code, anything) are saved and Claude reads them
- What you attached shows on the card, in the details panel and in Chat; click an image to open it big

## 0.13.4

- Concepts are plainer and more direct: a comparison only when it really helps
- Fewer, better concepts: at most one per step, and only ideas worth knowing; small and routine things are skipped

## 0.13.3

- With the details panel open, the message box moves into the space left of it, so the mic and send buttons stay clickable

## 0.13.2

- Sending while dictating stops the microphone and sends what it heard; nothing comes back into the box afterwards

## 0.13.1

- Click anywhere on a card to open its details; the card glides to the middle of the space left of the panel
- Agent replies read properly: tables, headings, numbered and nested lists, task lists, quotes, links and code all render cleanly

## 0.13.0

- "Got it" on concepts: tick a concept and it clears from the step views. It stays in Concepts, marked as reviewed, and you can bring it back
- Dictate in the message box: the microphone button types what you say as you speak (Chrome and Safari)

## 0.12.1

- Scrolling and zooming work over notes and cards too: notes grow to fit their content, and scroll areas inside cards hand the wheel to the canvas when there's nothing left to scroll. Pinch or ⌘-scroll always zooms
- The details panel, the selected card and the terminal stay in sync: open details on a card and it becomes the selected one; select another card (or send a prompt) and the open panel follows

## 0.12.0

- Notes folder: move notes you want to keep for later (on-call steps, setup commands) off the canvas with the folder button. Find them under Notes in the sidebar, next to Concepts
- Open a note there to edit it on a big paper sheet, tick its checklist, recolour it, or put it back on the canvas
- New notes can start right in Notes. On phones, Notes sits next to Concepts in the Learn tab

## 0.11.2

- Floating panels: the sidebar, the step details and the terminal float as rounded panels instead of being stuck to the window edge
- Hide the sidebar for more room (⌘\ or the button next to the logo); a button at the top left brings it back
- The "Add this image?" card on notes has neatly stacked buttons and a close button in the corner

## 0.11.1

- Images in notes: paste or drop an image on a note and choose Add image, or Turn into text to type out what's written in it (lists and checkboxes included)
- Notes grow to fit what you add

## 0.11.0

- Screenshots on threads: set your app's address in board settings and Forkspace snaps it after each step that changes files. The newest becomes the thread's cover above its title, so you can see what each thread built
- Add your own: paste (⌘V) onto a selected step, drop an image on a card, or Add screenshot… in the card menu. Click any preview to see it big

## 0.10.1

- Sticky notes, reworked: they always sit above cards, new ones land in free space, and they look like paper
- Checklists in notes: write "- [ ] task" and tick it off, with a progress line; lists continue when you press Enter
- Headings, bullets and **bold** in notes; colours, a checklist button and delete on hover

## 0.10.0

- Every thread has a title, in a box between its circle and its first card. Imported threads keep their Claude Code title; new ones get a short title when the first step finishes. Click a title to rename it
- Importing Claude Code sessions no longer turns background task notices into steps

## 0.9.5

- The message box has a soft watercolour glow that drifts slowly, and brightens while you type

## 0.9.4

- A calmer top bar: the board name opens a menu with its folder, permissions, Learn on or off and settings; terminal and search are icons. Full access still shows, in red, when it's on

## 0.9.3

- Checkpoint commits are authored as you (your git name and email), so hosts like Vercel accept them
- Commit messages describe the work in conventional style ("fix(cart): …", "feat: …"), match your repo's recent commits, and include a ticket like ENG-1234 when one is in your prompt, the conversation or your branch name

## 0.9.2

- The terminal follows the card you click: it switches to that branch's terminal, or opens one in its folder
- Every code block has a copy button

## 0.9.1

- Concepts in even simpler words: an everyday comparison first, then what it means in your code
- Calmer while agents work: at most two concepts per step, a concept you're reading never folds away or moves, and new ones wait quietly with a New tag
- The floating concepts box in Code shows one at a time, with a "new" button when more arrive

## 0.9.0

- A terminal in the app: the Terminal button (or Ctrl+`) opens a real shell at the bottom, in the folder of the branch you're on. Tabs, resizable, keeps running when hidden
- Other devices can't use the terminal unless you allow it on the computer (Settings, Phone)

## 0.8.1

- A calmer step details panel: your prompt, what changed, one Reply button, and Summary, Steps and Changes. Branch, folder and terminal commands moved behind ⋯
- On phones the panel now fills the screen properly
- Esc closes a menu without closing what's behind it

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
