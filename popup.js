const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function tabIcon(t) {
  if (t.favIcon) return `<img src="${esc(t.favIcon)}" onerror="this.style.display='none'">`;
  const letter = (t.host || "?").charAt(0).toUpperCase();
  return `<span style="width:16px;height:16px;border-radius:4px;background:#334155;color:#94a3b8;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;flex:none">${esc(letter)}</span>`;
}

async function refresh() {
  let st;
  try {
    st = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  } catch {
    return; // worker asleep; next tick retries
  }
  const session = st.session, switches = st.switches || 0;
  const live = !!session;
  $("dot").className = "dot" + (live ? " live" : "");
  $("start").style.display = live ? "none" : "";
  $("stop").style.display = live ? "" : "none";
  $("pin").disabled = false;

  if (live) {
    const s = session;
    const isBreak = Array.isArray(s.phases) && s.phases[s.phaseIndex]
      ? s.phases[s.phaseIndex].type === "break"
      : false;
    const anchor = isBreak ? s.phaseEndsAt : s.endsAt;
    const denom = isBreak
      ? Math.max(1, s.phaseEndsAt - (s.phaseStartedAt || (s.phaseEndsAt - 10 * 60000)))
      : (s.endsAt - s.startedAt);
    $("sTimeK").textContent = isBreak ? "break left" : "left";
    $("sTime").textContent = fmtClock(anchor - Date.now());
    $("sTime").className = "v " + (isBreak ? "" : "green");
    $("sTime").style.color = isBreak ? "#fbbf24" : "";
    $("sSwitch").textContent = switches;
    $("sUrge").textContent = (s.urgeLog || []).length;
    $("bar").style.width = Math.min(100, Math.max(0, ((denom - (anchor - Date.now())) / denom) * 100)) + "%";
    const endAt = new Date(s.endsAt);
    $("eta").textContent = `session ends ${endAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · live countdown while open`;

    // Phase banner: Focus 1 of 2 / Break, upcoming phases, skip-break during break.
    const phases = Array.isArray(s.phases) ? s.phases : [{ type: "focus", minutes: s.plannedMinutes || 120 }];
    const idx = Math.min(s.phaseIndex || 0, phases.length - 1);
    const cur = phases[idx];
    const focuses = phases.filter((p) => p.type === "focus").length;
    const focusNo = phases.slice(0, idx + 1).filter((p) => p.type === "focus").length;
    const upcoming = phases.slice(idx + 1).map((p) => `${p.minutes}m ${p.type}`).join(" → ");
    const phaseLeft = fmtClock((s.phaseEndsAt || s.endsAt) - Date.now());
    $("phaseLine").innerHTML = cur.type === "break"
      ? `<div class="phase break">☕ Break — ${phaseLeft} left, step away from the screen<span class="next">${upcoming ? "Next: " + esc(upcoming) : ""} · jail paused, blocks stay on</span></div>
         <div class="row" style="margin-top:6px"><button class="btn" id="skipBreak" style="background:#f59e0b;color:#451a03">Skip break → focus</button></div>`
      : `<div class="phase focus">${focuses > 1 ? `🟢 Focus ${focusNo} of ${focuses}` : "🟢 Focus"} — ${phaseLeft} left${isBreak ? "" : ""}<span class="next">${upcoming ? "Up next: " + esc(upcoming) : "Final stretch — finish strong"}</span></div>`;
    const skipBtn = $("skipBreak");
    if (skipBtn) skipBtn.onclick = async () => {
      if (!confirm("Skip the break? Your brain consolidates during rest — skipping is allowed but logged.")) return;
      await chrome.runtime.sendMessage({ type: "SKIP_BREAK" });
      refresh();
    };

    // Search-spiral meter: recent YouTube searches in the 5-min window.
    const slog = (s.searchLog || []).filter((e) => Date.now() - e.at < 5 * 60000);
    const sbox = $("searchNote");
    if (slog.length >= 2) {
      const last = slog[slog.length - 1];
      sbox.style.display = "";
      sbox.innerHTML = `🔎 <b>${slog.length} YouTube searches</b> in 5 min${last && last.query ? ` · latest: “${esc(last.query)}”` : ""}${slog.length >= 4 ? " — spiral risk, back to the lecture?" : " — lecture-driven is fine, spiral isn't."}`;
    } else sbox.style.display = "none";

    const planTxt = phases.map((p) => `${p.minutes}m ${p.type}`).join(" → ");
    $("planLine").textContent = `Plan: ${planTxt} · YT watch open, Shorts/feed blocked`;

    const tabs = s.studyTabs || [];
    $("pinCount").textContent = tabs.length ? `(${tabs.length})` : "";
    $("studyList").innerHTML = tabs.length
      ? tabs.map((t) => `
        <div class="studytab">
          ${tabIcon(t)}
          <div class="t">
            <b title="${esc(t.url || "")}">${esc(t.title || t.host || "Untitled tab")}</b>
            <span class="${t.closed ? "closed" : ""}">${t.closed ? "⚠ closed — reopen it, then re-pin" : "🟢 " + esc(t.host || "pinned") + " · switches free"}</span>
          </div>
          <button data-unpin="${t.id}" title="Unpin this tab">✕</button>
        </div>`).join("")
      : `<div class="empty">No study tabs pinned yet.<br>Open your lecture tab, then hit <b>📌 Pin this tab</b>.</div>`;

    $("urges").innerHTML = (session.urgeLog || []).length
      ? session.urgeLog.slice(-6).reverse().map((u) => `
        <div class="urge">
          <span>🅿️</span>
          <div class="col"><b>${esc(u.text)}</b>${u.site ? `<div class="site">🔗 ${esc(u.site)} — unlocks after session</div>` : ""}</div>
          <span class="ago">${ago(u.at)}</span>
        </div>`).join("")
      : `<div class="empty">Nothing parked. When an urge hits, type it instead of opening it.</div>`;
  } else {
    $("sTime").textContent = "–";
    $("sTime").className = "v";
    $("sTime").style.color = "";
    $("sTimeK").textContent = "left";
    $("sSwitch").textContent = "0";
    $("sUrge").textContent = "0";
    $("bar").style.width = "0%";
    $("phaseLine").innerHTML = "";
    $("searchNote").style.display = "none";
    $("eta").textContent = "";
    $("planLine").textContent = "YouTube watch stays open · Shorts & feed blocked";
    $("pinCount").textContent = "";
    $("studyList").innerHTML = `<div class="empty">Start a session first — the tab you're on gets pinned automatically. Pin more tabs any time with <b>📌 Pin this tab</b>.</div>`;
    $("urges").innerHTML = `<div class="empty">Parked urges appear here with the site you named.</div>`;
  }
}

document.querySelector("#studyList").addEventListener("click", async (e) => {
  const id = e.target?.dataset?.unpin;
  if (!id) return;
  await chrome.runtime.sendMessage({ type: "UNPIN_STUDY_TAB", tabId: parseInt(id) });
  refresh();
});

function curTabMeta() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
    if (!t) return null;
    let host = "";
    try { host = new URL(t.url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
    return { id: t.id, title: t.title || "", url: t.url || "", host, favIcon: t.favIconUrl || "" };
  });
}

$("start").onclick = async () => {
  const minutes = parseInt($("minutes").value) || 120;
  const plan = minutes >= 70 ? `${minutes} min = 50 focus → 10 break → ${minutes - 60} focus. OK?` : `${minutes} min single focus block, no break. OK?`;
  if (!confirm(`Start session? ${plan}`)) return;
  const whitelist = $("whitelist").value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const meta = await curTabMeta();
  await chrome.runtime.sendMessage({
    type: "START_SESSION",
    minutes,
    whitelist,
    studyTabs: meta ? [meta] : [],
  });
  refresh();
};

$("pin").onclick = async () => {
  const meta = await curTabMeta();
  if (!meta) return;
  const res = await chrome.runtime.sendMessage({ type: "PIN_STUDY_TAB", ...meta }).catch(() => null);
  if (!res || !res.ok) {
    // No active session: start one with this tab pinned.
    const whitelist = $("whitelist").value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    await chrome.runtime.sendMessage({ type: "START_SESSION", minutes: parseInt($("minutes").value) || 120, whitelist, studyTabs: [meta] });
  }
  refresh();
};

$("stop").onclick = async () => {
  let switches = 0;
  try { ({ switches } = await chrome.runtime.sendMessage({ type: "GET_STATUS" })); } catch { /* ignore */ }
  if (switches > 0 && !confirm(`End session with ${switches} tab-switches? Data saved, no judgment.`)) return;
  await chrome.runtime.sendMessage({ type: "END_SESSION" });
  refresh();
};

$("park").onclick = async () => {
  const text = $("urge").value.trim();
  if (!text) return;
  await chrome.runtime.sendMessage({ type: "PARK_URGE", text });
  $("urge").value = "";
  refresh();
};
$("urge").addEventListener("keydown", (e) => { if (e.key === "Enter") $("park").click(); });

refresh();
setInterval(tick, 1000);
setInterval(refresh, 15000);

// Lightweight 1s tick: countdown + progress bar only, no re-render (no flicker).
// During breaks the anchor is the break end (amber); otherwise the session end.
let cached = null;
async function tick() {
  try {
    if (!cached || !cached.session) return;
    const s = cached.session;
    const isBreak = Array.isArray(s.phases) && s.phases[s.phaseIndex]
      ? s.phases[s.phaseIndex].type === "break"
      : false;
    const anchor = isBreak ? s.phaseEndsAt : s.endsAt;
    const leftMs = anchor - Date.now();
    if (s.endsAt - Date.now() <= 0) { refresh(); cached = null; return; }
    if (leftMs <= 0) { refresh(); return; }
    $("sTime").textContent = fmtClock(leftMs);
    const denom = isBreak
      ? Math.max(1, anchor - (s.phaseStartedAt || (anchor - 10 * 60000)))
      : (s.endsAt - s.startedAt);
    $("bar").style.width = Math.min(100, Math.max(0, ((denom - leftMs) / denom) * 100)) + "%";
  } catch { /* ignore */ }
}
const _refresh = refresh;
refresh = async function () { try { cached = await chrome.runtime.sendMessage({ type: "GET_STATUS" }); } catch { /* keep old cache */ } return _refresh(); };
