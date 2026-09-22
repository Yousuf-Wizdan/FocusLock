// FocusLock background service worker — session state, tab-switch jail, blocklist enforcement.

const DEFAULT_STATE = {
  session: null, // { startedAt, endsAt, plannedMinutes, whitelist: [...], studyTabs: [{id,title,url,host,favIcon,closed}], urgeLog: [{at,text,site}] }
  switches: 0,   // tab switches this session (switches TO pinned study tabs are free, not counted)
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

// Pull a domain-looking token out of free text ("check instagram", "youtube.com shorts").
function siteOf(text) {
  const m = String(text || "").toLowerCase().match(/([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}/);
  return m ? m[0].replace(/^www\./, "") : "";
}

async function getState() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_STATE));
  return { ...DEFAULT_STATE, ...stored };
}

// Migrate legacy sessions that stored bare tab-id arrays.
function studyList(session) {
  if (!session) return [];
  if (Array.isArray(session.studyTabs)) return session.studyTabs;
  if (Array.isArray(session.studyTabIds)) {
    session.studyTabs = session.studyTabIds
      .filter((n) => Number.isInteger(n))
      .map((id) => ({ id, title: "", url: "", host: "", favIcon: "", closed: false }));
    return session.studyTabs;
  }
  return [];
}

// ---- session lifecycle ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "START_SESSION") {
      const now = Date.now();
      const minutes = msg.minutes || 120;
      const whitelist = (msg.whitelist || []).map((h) => h.trim().toLowerCase()).filter(Boolean);
      const studyTabs = Array.isArray(msg.studyTabs)
        ? msg.studyTabs.filter((t) => t && Number.isInteger(t.id))
            .map((t) => ({ id: t.id, title: t.title || "", url: t.url || "", host: t.host || "", favIcon: t.favIcon || "", closed: false }))
        : [];
      const legacyIds = Array.isArray(msg.studyTabIds) ? msg.studyTabIds.filter((n) => Number.isInteger(n)) : [];
      for (const id of legacyIds) {
        if (studyTabs.some((t) => t.id === id)) continue;
        let meta = { title: "", url: "", favIcon: "" };
        try {
          const t = await chrome.tabs.get(id);
          meta = { title: t.title || "", url: t.url || "", favIcon: t.favIconUrl || "" };
        } catch { /* tab gone */ }
        studyTabs.push({ id, title: meta.title, url: meta.url, host: hostOf(meta.url || ""), favIcon: meta.favIcon, closed: false });
      }
      await chrome.storage.local.set({
        session: { startedAt: now, endsAt: now + minutes * 60 * 1000, plannedMinutes: minutes, whitelist, studyTabs, urgeLog: [] },
        switches: 0,
      });
      chrome.alarms.create("focusEnd", { when: now + minutes * 60 * 1000 });
      chrome.alarms.create("focusHalf", { when: now + (minutes * 60 * 1000) / 2 });
      sendResponse({ ok: true });
    } else if (msg.type === "PIN_STUDY_TAB") {
      const st = await getState();
      if (!st.session) { sendResponse({ ok: false, reason: "no-session" }); return; }
      const tabs = studyList(st.session);
      if (Number.isInteger(msg.tabId) && !tabs.some((t) => t.id === msg.tabId)) {
        let meta = { title: msg.title || "", url: msg.url || "", favIcon: msg.favIcon || "" };
        if ((!meta.url || !meta.title) && Number.isInteger(msg.tabId)) {
          try {
            const t = await chrome.tabs.get(msg.tabId);
            meta = { title: t.title || meta.title, url: t.url || meta.url, favIcon: t.favIconUrl || meta.favIcon };
          } catch { /* ignore */ }
        }
        tabs.push({ id: msg.tabId, title: meta.title, url: meta.url, host: msg.host || hostOf(meta.url || ""), favIcon: meta.favIcon, closed: false });
        st.session.studyTabs = tabs;
        await chrome.storage.local.set({ session: st.session });
      }
      sendResponse({ ok: true, studyTabs: studyList(st.session) });
    } else if (msg.type === "UNPIN_STUDY_TAB") {
      const st = await getState();
      if (st.session) {
        st.session.studyTabs = studyList(st.session).filter((t) => t.id !== msg.tabId);
        await chrome.storage.local.set({ session: st.session });
      }
      sendResponse({ ok: true });
    } else if (msg.type === "END_SESSION") {
      await chrome.storage.local.set({ session: null });
      await chrome.alarms.clearAll();
      sendResponse({ ok: true });
    } else if (msg.type === "PARK_URGE") {
      const st = await getState();
      if (st.session) {
        const text = String(msg.text || "").slice(0, 200);
        st.session.urgeLog.push({ at: Date.now(), text, site: siteOf(text) });
        await chrome.storage.local.set({ session: st.session });
        sendResponse({ ok: true, count: st.session.urgeLog.length });
      } else sendResponse({ ok: false });
    } else if (msg.type === "GET_STATUS") {
      const st = await getState();
      if (st.session) {
        // Refresh pinned-tab identities live; mark closed tabs instead of dropping them.
        const fresh = [];
        for (const p of studyList(st.session)) {
          try {
            const t = await chrome.tabs.get(p.id);
            fresh.push({
              id: p.id,
              title: t.title || p.title || "",
              url: t.url || p.url || "",
              host: hostOf(t.url || p.url || ""),
              favIcon: t.favIconUrl || p.favIcon || "",
              closed: false,
            });
          } catch {
            fresh.push({ ...p, closed: true });
          }
        }
        st.session.studyTabs = fresh;
        await chrome.storage.local.set({ session: st.session });
      }
      const cur = await getState();
      sendResponse({ session: cur.session, switches: cur.switches, blocklist: cur.blocklist });
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
// Pinning exempts the *switch*, never the *content*: blocklist + YT guard still apply.
let jailUntil = 0;
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const st = await getState();
  if (!st.session) return;
  const pinnedIds = studyList(st.session).filter((t) => !t.closed).map((t) => t.id);
  if (pinnedIds.includes(tabId)) return; // study tab: no count, no jail
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
  const fromHost = hostOf(url || "");
  chrome.tabs.update(tabId, {
    url: chrome.runtime.getURL("jail.html") + `?n=${n}&wait=${Math.round(jailMs / 1000)}&from=` + encodeURIComponent(fromHost),
  });
});
