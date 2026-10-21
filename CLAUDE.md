# Framewright agent instructions

Read and follow [AGENTS.md](AGENTS.md) for the recipe contract, render → inspect →
propose workflow, library separation, tests, and creative-content restrictions.

## Keyboard shortcuts

Every common action needs a key reachable one-handed in both postures: right
hand alone (thumb on the trackpad, fingers on the right half of the keyboard)
and left hand on the keyboard with the right on the trackpad. Today that is
P or X to pick, Space or Enter to play video, arrows/HJKL to move, `,`/`.` to
step frames, ⌫ or Z to mark for deletion, S to add to a collection (⇧S adds
all picks), F/O to filter, and G/D/⇧P/T for tabs. Deleting only ever moves
files to the Trash, from the Marked for deletion filter.
Keep a key's meaning the same across tabs (pick is never something else
somewhere), and update the shortcut lists in `web/index.html` with any change.

## What's new

Every user-visible change adds an entry at the top of
`framewright/web/changes.json`: the next `id` and a `text` of a few words
(e.g. "Draggable dividers"), no sentences. After an update the app shows a
toast naming the entries that window hasn't seen yet.

AGENTS.md and CLAUDE.md must stay in sync: when you change guidance in one,
make the same change in the other.
