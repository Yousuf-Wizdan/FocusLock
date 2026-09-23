# FOCUSLOCK_AUDIT.md — v1 audit (pre-rebuild, 2026-09-23)

## Architecture (v1)
MV3 SW (`background.js`, ~575 lines) + `content.js` @ document_start on
`<all_urls>` + popup/options/blocked/jail/break pages. State: flat v1 keys
in chrome.storage.local. Triple enforcement: tabs.onUpdated +
webNavigation.onCommitted/onHistoryStateUpdated + content.js, each with its
OWN matcher copy (already drifted: `?list=` exception only in content.js;
host normalization differs across 3 files).

## Bugs found (severity)
P0 — pinning uses ephemeral tab ids only; reopened lecture never heals (§4).
P0 — START_SESSION pins current tab WITHOUT block-check; session can start
  ON instagram as "study" (background.js:244).
P0 — jail replaces destination URL, only hostname kept; Back loops (§10).
P0 — `let jailUntil` in-memory; SW death loses jail state (§11).
P0 — focusEnd + phase alarms can double-complete; history double-records (§13).
P0 — YouTube channel Shorts (/@h/shorts, /channel/UC../shorts, /c/n/shorts),
  youtu.be, music.youtube.com mishandled by YT_DISTRACTION_PATHS (§7).
P1 — content.js polls every 1s; popup refreshes every 15s + per-tick storage
  writes (§34). P1 — GET_STATUS rewrites session + tabs.get loop per call.
P1 — double-bounce flicker from 3 unsynchronized layers (§33).
P1 — confirm()/alert() in popup (§20). P1 — external favicon fetch
  (google.com/s2) = only network call + review flag (§24).
P2 — guilt copy ("habit is expensive") (§36). P2 — dark-only, no a11y
  reduced-motion on pages, sloppy manifest (name/description/version) (§26).

## Feature classification (§2)
KEEP: micro-sprint phases, blocklist+YT-guard concept, urge parking,
  search tripwire, break enforcement, journal/streak.
FIX: verdict (→ policy.js), pinning (→ canonical keys + healing),
  jail/blocked (→ context-preserving + persisted timestamps).
SIMPLIFY: options page (→ settings sections), popup ledger.
REMOVE: google s2 favicons (→ tab favIcons), 15s popup polling, in-memory
  jailUntil, guilt copy, CHATGPT prompt doc from ship zip.
REPLACE: state schema (→ versioned fl_state_v2 + migration), content.js
  (→ thin shared-policy mirror, event-driven), all 4 HTML pause pages.

## Security (§30)
Fixed: raw `raw` URL rendered into blocked.html small tag is now textContent
only; no innerHTML with URL data anywhere; blocklist entries validated
against /^[a-z0-9.-]+\.[a-z]{2,}$/ on save; javascript:/data: URLs → "open"
(never bounced, never pinned); own-page guard via runtime.getURL prefix.
Residual: blocked.html `location.replace(raw)` only fires after a user
clicked "2-minute pass" for that host — acceptable, logged.

## Permissions (§25)
Kept: tabs, storage, alarms, notifications, webNavigation, <all_urls>.
Justified in PRIVACY.md + STORE_LISTING.md. DNR evaluated and REJECTED:
it cannot express "block Shorts but allow watch on the same host" without an
unmaintainable rule list and cannot do the jail/park UX. Mitigation for
review: content script does URL-check + redirect only, no DOM scraping.

## Store risks (§26)
<all_urls> will draw a question — justification text written. No remote
code, no analytics, icons present, min_chrome_version 116, descriptions
rewritten. Screenshots still TODO (needs real Chrome).

## What was built (v2)
policy.js (single verdict), store.js (versioned state + migration),
background.js (one pipeline, exactly-once completion, persisted jail,
SW-restart recovery), content.js (thin event-driven mirror), popup v2
(goal, debrief, no alert/confirm, light+dark), blocked/jail/break v2
(return-to-study, park, emergency pass), options v2 (settings sections),
PRIVACY.md, STORE_LISTING.md. Tests: 34 verdict cases + migration test,
all passing. Release zip: focuslock-2.0.0.zip (25 files).
