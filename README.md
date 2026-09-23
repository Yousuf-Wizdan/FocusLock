# 🔒 FocusLock — Study Guard (v2.1.0)

A Chrome/Edge/Brave MV3 extension for students who keep tab-switching while studying.
Study pages stay open. Distractions wait. Urges get parked, not punished.

## The problem it solves

You sit down to study from a YouTube lecture. Ten minutes later you're on
Shorts, then Instagram, then Reddit. Existing blockers either block YouTube
entirely (useless when your lecture IS on YouTube) or are one click to ignore.

## How FocusLock is different

- **YouTube study guard, not YouTube block.** `/watch`, `/playlist`,
  `/embed`, `/live`, search results and channel pages always stay open.
  Only Shorts (including channel `/shorts` tabs), home feed, trending,
  explore, gaming and podcasts pause during a session. `youtu.be` share
  links canonicalize to their lecture.
- **Study-tab pinning with healing.** Pin lecture tabs; switching between
  them is free. Tabs are identified by canonical URL + tab id, so closing
  and reopening the same lecture rejoins the session. Blocked pages can
  never be pinned — at pin time, at session start, or on restore.
- **Tab-switch pause.** Leaving study tabs during focus shows a calm wait
  screen with an escalating pause (3s, grows every 5 switches, capped 20s).
  Timing is persisted — it survives service-worker restarts.
- **Urge parking.** Type the urge ("check insta") instead of opening it.
  Saved locally for review after the session.
- **Emergency pass.** Need 2 minutes on a paused site? Write a reason
  (logged in the session) and get one site, 2 minutes, then the guard returns.
- **Real breaks + debrief.** Long sessions include a step-away break
  (skippable, logged). Ending shows a summary: planned time, switches,
  paused pages, parked urges.
- **Blocklist.** ~40 defaults (Instagram, X/Twitter, Reddit, Facebook,
  Netflix, Hotstar, chess, cricket, shopping, food delivery…) plus your own
  domains. Editable in Settings; subdomains included automatically.

## Install (1 min)

1. Download / clone this repo
2. Open `chrome://extensions` → enable **Developer mode** (top right)
3. **Load unpacked** → select the repo folder
4. Pin the extension, open your lecture tab, pin it, then Start

## Usage

1. Open your study video/page tab → **Pin this tab**
2. Type what you're working on (optional) → pick 25/50/90/120 min → **Start session**
3. Study. Pinned tabs are free; everything else pauses
4. Park urges instead of opening them; take the break when it comes

## Files

- `policy.js` — single-source-of-truth URL verdict (shared by worker + content script)
- `store.js` — versioned state + v1 migration
- `background.js` — session engine, enforcement pipeline, jail, alarms
- `content.js` — thin SPA navigation mirror (no polling)
- `popup.html` / `popup.js` — Focus/Journal/Sites tabs, setup, timer, debrief
- `styles/` — design tokens, base, components (one system, light/dark/system)
- `ui.js` — shared theme/toast/dialog/icon helpers, no business logic
- `blocked.html` / `blocked.js` — pause screen + deliberate emergency access
- `jail.html` / `jail.js` — calm wait screen with return-to-study
- `break.html` / `break.js` — break screen with next-block preview
- `onboarding.html` / `onboarding.js` — 4-screen first-run (opens on install)
- `options.html` / `options.js` — General/Focus/Sites/Data/About rail settings
- `PRIVACY.md` / `STORE_LISTING.md` / `FOCUSLOCK_AUDIT.md` — privacy, store draft, audit

## Tests

- 34-case URL verdict matrix: `node -e` via `policy.js` (`require('./policy.js')`)
- v1→v2 migration: stub `chrome.storage`, seed v1 keys, `Store.loadState()`
- `node --check` on all JS files

## Privacy

100% local. No network calls, no analytics, no accounts. State lives in
`chrome.storage.local` only. See `PRIVACY.md`.
