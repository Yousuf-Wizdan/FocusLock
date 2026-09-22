# 🔒 FocusLock — 2 Hour Study Guard

A Chrome/Edge/Brave extension for students who keep tab-switching while studying.
Study pages stay open. Distractions get jailed.

## The problem it solves

You sit down to study from a YouTube lecture. Ten minutes later you're on
Shorts, then Instagram, then Reddit. Existing blockers either block YouTube
entirely (useless when your lecture IS on YouTube) or are one click to ignore.

## How FocusLock is different

- **YouTube study guard, not YouTube block.** `/watch`, `/playlist`,
  `/embed`, search results, live streams and channel pages always stay open.
  Only Shorts, home feed, trending, explore, gaming and podcasts get blocked
  during a session.
- **Study-tab pinning.** Open your lecture tab, hit "📌 This tab is study".
  Switching between pinned study tabs is free — switching anywhere else
  bounces you to a wait screen and increments your counter.
- **Tab-Switch Jail.** Every non-study switch shows a lock screen with an
  escalating wait (3s, grows every 5 switches, capped 20s). Switching stops
  feeling rewarding fast.
- **Urge parking.** Type the urge ("check insta") into the popup instead of
  opening it. Logged for review after the session.
- **Blocklist.** Instagram, X/Twitter, Reddit, Facebook, Netflix, Discord,
  Twitch, LinkedIn blocked during sessions. Editable in options.

## Install (1 min)

1. Download / clone this repo
2. Open `chrome://extensions` → enable **Developer mode** (top right)
3. **Load unpacked** → select the `focuslock` folder
4. Pin the extension, click it, open your lecture tab first, then Start

## Usage

1. Open your study video/page tab
2. Click FocusLock → **📌 This tab is study** (starting a session auto-pins
   the current tab too)
3. Set minutes (default 120) → **Start session**
4. Study. Switches to pinned tabs are free; everything else gets jailed
5. Halfway ping at 50%, completion notification at the end

## Files

- `manifest.json` — MV3 manifest
- `background.js` — session state, blocklist + YouTube guard, switch jail
- `content.js` — instant in-page bounce for blocked / YT-distraction URLs
- `popup.html` / `popup.js` — session controls, pin button, urge parking
- `jail.html` — tab-switch wait screen
- `blocked.html` — blocked-page screen (with YouTube-specific message)
- `options.html` — editable blocklist

## Privacy

100% local. No network calls, no analytics, no accounts. State lives in
`chrome.storage.local` only.
