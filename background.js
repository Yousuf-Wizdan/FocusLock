// FocusLock background service worker — session state, tab-switch jail, blocklist enforcement.

const DEFAULT_STATE = {
  session: null, // { startedAt, endsAt, plannedMinutes, whitelist: [host...], studyTabIds: [tabId...], urgeLog: [] }
  switches: 0,   // tab switches this session (study-tab switches are free, not counted)
  blocklist: [
    "instagram.com", "x.com", "twitter.com",
    "reddit.com", "facebook.com", "netflix.com", "discord.com",
    "twitch.tv", "linkedin.com"
  ],
};

// Hosts that are study sources: never fully blocked, only their
// distraction paths are (Shorts, home feed, trending...). Watch,
// playlist, embed and search pages always stay open.
const STUDY_GUARD_HOSTS = ["youtube.com", "youtu.be", "music.youtube.com"];

// YouTube paths that are pure distraction (blocked during sessions).
// Everything else (/watch, /playlist, /embed, /results, /live, channels) stays open.
const YT_DISTRACTION_PATHS = [/^\/$/, /^\/shorts(\/|$)/, /^\/feed(\/|$)/, /^\/trending/, /^\/explore/, /^\/gaming/, /^\/podcasts/];

function ytDistraction(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  if (!STUDY_GUARD_HOSTS.includes(host)) return false;
  if (host === "youtu.be") return false; // share links resolve to watch pages
  return YT_DISTRACTION_PATHS.some((re) => re.test(u.pathname));
}

async function getState() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_STATE));
  return { ...DEFAULT_STATE, ...stored };
}

// ---- session lifecycle ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "START_SESSION") {
      const now = Date.now();
      const minutes = msg.minutes || 120;
      const whitelist = (msg.whitelist || []).map((h) => h.trim().toLowerCase()).filter(Boolean);
      const studyTabIds = Array.isArray(msg.studyTabIds) ? msg.studyTabIds.filter((n) => Number.isInteger(n)) : [];
      await chrome.storage.local.set({
        session: { startedAt: now, endsAt: now + minutes * 60 * 1000, plannedMinutes: minutes, whitelist, studyTabIds, urgeLog: [] },
        switches: 0,
      });
      chrome.alarms.create("focusEnd", { when: now + minutes * 60 * 1000 });
      chrome.alarms.create("focusHalf", { when: now + (minutes * 60 * 1000) / 2 });
      sendResponse({ ok: true });
    } else if (msg.type === "PIN_STUDY_TAB") {
      const st = await getState();
      if (st.session && Number.isInteger(msg.tabId) && !st.session.studyTabIds.includes(msg.tabId)) {
        st.session.studyTabIds.push(msg.tabId);
        await chrome.storage.local.set({ session: st.session });
      }
      const cur = await getState();
      sendResponse({ ok: true, studyTabIds: cur.session ? cur.session.studyTabIds : [] });
    } else if (msg.type === "END_SESSION") {
      await chrome.storage.local.set({ session: null });
      await chrome.alarms.clearAll();
      sendResponse({ ok: true });
    } else if (msg.type === "PARK_URGE") {
      const st = await getState();
      if (st.session) {
        st.session.urgeLog.push({ at: Date.now(), text: String(msg.text || "").slice(0, 200) });
        await chrome.storage.local.set({ session: st.session });
        sendResponse({ ok: true, count: st.session.urgeLog.length });
      } else sendResponse({ ok: false });
    } else if (msg.type === "GET_STATUS") {
      const st = await getState();
      sendResponse({ session: st.session, switches: st.switches, blocklist: st.blocklist });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "focusEnd") {
    await chrome.storage.local.set({ session: null });
    await chrome.alarms.clearAll();
    chrome.notifications.create({
      type: "basic", iconUrl: "icon128.png",
      title: "FocusLock — session complete",
      message: "2 hours done. Take a real break, you earned it.",
    });
  } else if (alarm.name === "focusHalf") {
    const st = await getState();
    if (st.session) {
      chrome.notifications.create({
        type: "basic", iconUrl: "icon128.png",
        title: "FocusLock — halfway",
        message: `1 hour done. ${st.switches} tab-switches so far. Keep going.`,
      });
    }
  }
});

// ---- enforcement: blocklist + Tab-Switch Jail ----
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function isAllowed(url, st) {
  const host = hostOf(url);
  if (!host) return true;
  const inBlock = st.blocklist.some((b) => host === b || host.endsWith("." + b));
  if (!inBlock) return true;
  if (st.session && st.session.whitelist.some((w) => host === w || host.endsWith("." + w))) return true;
  return false;
}

async function enforce(tabId, url, st) {
  st = st || (await getState());
  if (!st.session || !url) return;
  if (!isAllowed(url, st)) {
    await chrome.tabs.update(tabId, { url: chrome.runtime.getURL("blocked.html") + "?from=" + encodeURIComponent(url) });
  } else if (ytDistraction(url)) {
    // YouTube study guard: watch/search stay open, Shorts/feed/trending bounce.
    await chrome.tabs.update(tabId, { url: chrome.runtime.getURL("blocked.html") + "?from=" + encodeURIComponent(url) + "&why=yt" });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") enforce(tabId, changeInfo.url || tab.url);
});

// Tab-Switch Jail: every switch during a session bounces back with escalating delay.
// Switches TO a pinned study tab are free (studying from 2 tabs is normal).
let jailUntil = 0;
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const st = await getState();
  if (!st.session) return;
  if (st.session.studyTabIds && st.session.studyTabIds.includes(tabId)) return; // study tab: no count, no jail
  const n = (st.switches || 0) + 1;
  await chrome.storage.local.set({ switches: n });
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab ? tab.url : null;
  if (url && !isAllowed(url, st)) { enforce(tabId, url, st); return; }
  if (url && ytDistraction(url)) { enforce(tabId, url, st); return; }
  if (Date.now() < jailUntil) return;
  // Jail: 3s + 2s per 5 switches, capped 20s. Feels annoying, not broken.
  const jailMs = Math.min(3000 + Math.floor(n / 5) * 2000, 20000);
  jailUntil = Date.now() + jailMs;
  chrome.tabs.update(tabId, {
    url: chrome.runtime.getURL("jail.html") + `?n=${n}&wait=${Math.round(jailMs / 1000)}`,
  });
});
