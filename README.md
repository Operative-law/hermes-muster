# Muster

The morning stand-up for parallel agent work in Hermes Desktop.

If you run five or more Hermes threads at once, the morning starts with a question: which of yesterday's threads am I picking up, and where do I put them? Muster answers it in one dialog.

1. **Recap.** Muster lists the threads you worked on last (yesterday, or Friday on a Monday) and anything already moving today. Each row shows the thread's live status dot, project, message count and last activity.
2. **Pick.** Those threads start ticked. Untick what can wait. Scroll or search the older threads to add any of them.
3. **Lay out.** Muster previews the grid for that number of threads (2 or 3 across, 2×2, 3+2, 3×2, 4+3, 4×2). Click **Lay out** and each thread gets its own zone. More than eight threads stack as tabs in the first zone.

Open it from the **Muster** chip in the status bar, from ⌘K → "Muster: plan today", or from the optional morning reminder. ⌘K → "Muster: restore today's layout" rebuilds the grid after you rearrange it. Settings → Plugins → Muster has two switches: remind me each morning, or open Muster automatically.

## How it places chats

Grid placement uses three Desktop SDK verbs: `host.dockSession` (the placement a sidebar drag onto a zone edge performs, with an optional split share so columns come out even), `host.dockedSessions` and `host.undockSession`. Before laying out, Muster closes the chats docked from the day before, using the same path as a tab's Close button: ⌘⇧T brings any of them back, and a busy chat keeps running in the background.

**These verbs are proposed for Hermes Desktop and are not in a release yet.** On a Desktop without them, Muster feature-detects the gap and opens your chosen threads as tabs instead, and it tells you so. It never reaches past the plugin SDK.

## Disclosure

- **Desktop only** (`desktop/plugin.js`). No Python, no tools, no hooks, no background processes.
- **Reads** your session list through `host.listPersistedSessions`: titles, first-message previews, project paths and timestamps. It does not read transcripts.
- **Stores** today's lineup and two preferences in its own plugin storage. Nothing else is written.
- **No network calls, no model calls, no telemetry, no credentials.**

## Development

```
node --import ./tests/sdk-stub.mjs --test tests/plan.test.mjs
hermes plugins validate .
```

## Licence

MIT. See `LICENSE`.
