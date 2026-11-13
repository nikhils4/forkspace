# Changelog

Each version here is a release. Forkspace shows these notes in Settings when an update is ready.
To cut one: add a section below, then run `npm run release -- <version>`.

## 0.31.0

- Tidier sidebar: the header is just the logo, name, connection dot and one collapse button (⌘\ still hides it fully). The Agents section only shows while something is running
- Light, dark and terminal now sit together as a small switch at the bottom of the sidebar, next to Settings and Away. The terminal panel button in the top bar is no longer confused with terminal mode
- Away uses a phone icon, so the moon only ever means dark mode
- Concepts gets a plain bookmark icon, and the purple dot next to the board name (thread notes on) is gone from the top bar; it's still in the board menu

## 0.30.0

- Terminal mode: the whole app as a shell. Everything in monospace, phosphor green on black, square corners, no blur or glow, buttons in [ brackets ], faint scanlines, working cards blink, comments in amber. The terminal panel and code view follow it too
- Turn it on with the >_ button next to the logo, ⌥⌘T, or Settings → Appearance → Terminal. Turning it off goes back to the theme you had before

## 0.29.0

- Safety pauses explain themselves: under the command, what it would actually do and what could go wrong, in plain words (written in a few seconds by a small model)
- New choices on a safety pause: Allow once, Run it myself (types the command into a terminal in the card's folder for you to check and run; the agent carries on without it), or Skip, keep going (the agent skips just that command, finishes the rest, and lists what it skipped at the end). Saying no no longer stops the work
- Ordinary permission prompts get Skip, keep going too
- Smoother panning when zoomed out: the tags on working and ready cards no longer trail behind or re-blur every frame, the canvas no longer restyles every card on each move, and the dot grid hides when zoomed far out
- File edits under "How it got there" show as a red and green diff (− removed, + added, unchanged lines folded) instead of raw JSON, and each edit line shows its +/− counts

## 0.28.0

- Comments panel: the speech-bubble button on the canvas (with a count) lists every comment on the board, grouped by thread and step. Click a step to jump to its card
- Tick a comment off when it's dealt with. Done ones leave the card and sit under Done in the panel, where you can untick them
- Send one comment, or a thread's open comments all at once, to your next prompt from the panel
- The details panel shows a step's comments under what you asked, with when you wrote them
- Zoomed far out, cards with comments show a yellow count instead of hiding them

## 0.27.0

- Thread notes: every thread gets one note at its top, kept up to date by Claude after each step. It says what the thread is for, every change made (with links to the code), how it works step by step with each if/else spelled out, what was decided, and what's still open. Click any `file:line` in it to open that spot in the Code view
- Find a thread's notes on the tab above its first card, at the top of the details panel and the chat, or from the card's menu. Rewrite them from scratch any time
- Concepts is now your threads, explained: when you delete a thread its note moves there (or keep one there any time; it stays in sync while the thread lives). Search across everything you've built
- The old tech concepts (and Practice) are gone, cleared once on every device when it updates. "Learn concepts" in board settings is now "Thread notes"
- Forgot something while an agent is working? Send it anyway: it waits on the card ("1 queued") and runs as the next step in the same thread as soon as the agent finishes, even with the page closed. Several become one step, in order. Drop any of them with × above the message box. If the agent was stopped or failed, they stay put until you press Send now
- Choose a board's effort (how hard the model thinks) right under the model: Default, Low, Medium, High, Extra high or Max. Only the levels the chosen model takes are offered, each explained in a line
- Pick a board's model at the top of Board settings: the newest Opus, Sonnet, Haiku, Fable and Mythos, with older versions folded under "More versions". The list comes from your Claude account, so new models show up on their own
- Terminal tabs say where they are: your project's folder name, or the thread a card's own copy belongs to, plus what's running in it right now (yarn, node…) instead of "zsh 4 8Hq-coBd"
- New terminals (+) always open in your project's main folder. To work in a card's own copy, use "Terminal here" on the card's menu or in its details. Clicking a card no longer opens terminals by itself; it just shows that card's terminal if it has one
- In the details panel, keep scrolling past the top to move to the step above in the thread (past the bottom: the step after). A pill fills as you push so it never happens by accident; the panel slides and the canvas follows
- Safety rules for every agent, on every board, in every approval mode: agents never push (they give you the commands instead), never commit on their own, and stop to ask before using AWS or other clouds, databases that aren't on this machine, or credential files. The card says which rule paused it, and these can't be "always allowed"
- Fixed: "What changed" counted everyone else's work when an agent switched to newer code mid-step (for example `git checkout -b … origin/main`), showing hundreds of files instead of the handful it changed. Steps already saved this way are corrected on the next start
- Ready for review: when a card finishes while you're looking elsewhere, it says "Ready for review" (or "Failed, take a look"), on the card and on a tag at the edge of the view pointing to it. It clears once you click the card, open it, or start the next step from it
- Notes off screen get small, faint pointers at the edge of the view. They darken on hover; click one to fly to the note
- Tags at the edge of the view now always stay fully visible, instead of being cut off on the right next to the details panel
- Concepts page tidy-up: topic counts sit next to their name; file paths keep their real case; code in an idea no longer breaks words in half or hides under the copy button; names read "PR", "HMAC" and "Git" properly; on phones the search box isn't cut off, short cards aren't padded tall, and Practice doesn't show keyboard hints

## 0.26.0

- Save a flow: keep any walkthrough under a name ("Checkout"). Saved flows sit at the top of the map and in the side list, and never get pushed out by newer questions
- When the code changes after a flow was worked out, it says so; Refresh works it out again and keeps the name
- Check it for real: one click starts an agent that writes tests sending the walkthrough's example through the real code, one test per decision where it can. It works in its own copy of the code, never touches live databases, payments or email, and only changes tests
- The result shows on the walkthrough: a one-line verdict, a table of what matched, and anything the walkthrough got wrong or any bug it found. Open the thread to see the work

## 0.25.0

- Walkthroughs are easier to follow: each step has a short headline, and only the step you're on is open. The rest stay as one line each
- Every decision is spelled out: each if/else, limit, error, retry and special case gets its own "If … then …" box, coloured by what happens (stops, goes another way, skips, tries again), followed by what happens otherwise
- The journey is split into a few parts (like Holding stock, Paying, Saving the order) on a bar at the top; click one to jump there
- "What changed" says it in words. The raw data is one click away and remembers if you like it open
- Plainer language throughout: what the person sees, not status codes. The code details sit at the bottom of each step
- Play gives longer steps more time to read

## 0.24.0

- Map walkthroughs: ask how something happens ("What happens at checkout?") and watch it play out. A sample of the real data starts the trip, then each step shows the function, file and line, what it does in plain words, and how the data looks now, with new and changed fields highlighted
- The map follows along: the card for each step lights up, the path so far glows, and the database tables a step reads or changes pulse in their own colour (read, add, change, remove)
- Play, pause, or step with the arrow keys. Click any step to jump there or open its file at that exact line
- Open up any card (the arrow, or double click) to see the files and functions inside, each with one line on what it does and what it calls. Click one to open it at its line
- Data models show their fields right on the card, like a table
- The map suggests the main flows of your app to walk through, and keeps your questions so walkthroughs are there next time

## 0.23.0

- Map: a new view that shows how your project fits together. Claude reads the code (read-only, with your Claude Code login) and draws lanes for screens, API routes, logic, data, jobs and setup, with a card for every page, route, service and model and lines for what uses what
- Click a card to see what it does, what it connects to, and open its file in the Code view
- Ask anything about the codebase in plain words ("Where is checkout handled?"). The answer names files and lines, and the parts it's about light up on the map, numbered in the order to read them
- Search the map by name, route or file; Redraw when the code has changed (it tells you)

## 0.22.0

- Concepts, rebuilt: ten plain topics that don't overlap (Problem solving, The language, Code structure, Screens, Servers & APIs, Data, Speed, Safety, Testing & debugging, Tools & shipping), each with a line saying what lives there. Older concepts move over on their own
- Each topic is a shelf of idea cards: the name, the idea in one line, and how well you know it
- Open an idea for the one-line gist, the explanation, the real code it came from, what it goes with and where you met it
- Practice: flashcards to actually remember. See the name, think, flip. What you know comes back in days, the rest sooner
- "Got it" stays on steps only; the Concepts page no longer shows it

## 0.21.0

- The details panel is one page that reads top to bottom, no tabs: You asked, Answer, What changed, Worth knowing, and How it got there (folded)
- Its header says where you are: the thread's name and which step this is
- What changed is a tidy file list with counts; click a file to see its changes. When nothing changed, it says so in one quiet line
- Comments stay beside the card on the canvas; the panel no longer repeats them. The extra Reply button is gone too: the box at the bottom says what sending will do ("Reply · continues this thread" or "Branch · starts a new path from here")
- Explain this step and Copy folder path are in the panel's ⋯ menu

## 0.20.0

- Shrink the sidebar to a slim rail of icons (the ‹ button next to its name): Concepts, Notes, boards, working agents, Away and Settings stay one click away
- A card you send now glides to the middle of what you can see (left of the details panel, above the message box), even from far away on the board. It used to stay where it landed
- While it works, the view follows the card as it grows, until you move the view yourself

## 0.19.0

- Changes show while a step is still working, and for steps that were stopped: the branch folder as it is right now, new files included, refreshing as the agent edits
- A step cut off by a restart or update gets its checkpoint when Forkspace starts again, so its changes are never lost from view
- Steps that change nothing no longer make empty commits, and say so plainly: "This step didn't change any files"
- Steps that run in your own project folder show their changes too, using a hidden snapshot (your branch and staging area are never touched)

## 0.18.1

- Attached images and files on a card line up with the rest of the card instead of touching its edge

## 0.18.0

- Working cards say what they're doing, live: "Editing math.ts", "Running npm test", "Needs your OK". It replaces the plain "Running" label
- A thin light circles a working card's edge (amber when it needs you), in place of the thick glow
- Zoomed far out, working cards wear a readable tag. Off screen, the tag waits at the edge of the view and points the way; click it to fly there
- Little lights travel down the line into a working card

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
