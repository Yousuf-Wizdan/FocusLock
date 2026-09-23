# FocusLock — privacy

FocusLock is 100% local software.

- No account. No sign-in. No server.
- No analytics, telemetry, crash reporting, or tracking of any kind.
- No network requests except none: the extension makes zero requests to
  any server. (Favicons shown in the popup are Chrome's own tab favicons
  already on your device — never fetched from a remote service.)
- All data lives in `chrome.storage.local` on your device:
  - current session (timer, goal, study tabs, blocked-attempt count)
  - study-tab identities (tab id + canonical URL + title)
  - parked urges and emergency-pass reasons you typed
  - last 30 session summaries (duration, switches, completion)
  - settings (default length, YouTube guard, emergency pass, theme)
  - your custom blocklist additions
- Clearing the extension's storage (or uninstalling) deletes everything.
- Permissions and why each is needed:
  - `tabs` — read the current tab's URL/title to pin study tabs and to
    return you to them from pause screens.
  - `storage` — keep the session, settings, and history locally.
  - `alarms` — end focus/break phases on time even if the popup is closed.
  - `notifications` — break reminders and session-complete notices only.
  - `webNavigation` — detect page changes (including YouTube/Instagram
    SPA navigations) so pauses apply reliably.
  - `<all_urls>` host access — required because a distraction can be any
    website; the content guard only reads the current URL and redirects
    paused pages to the local pause screen. No page content is collected.
