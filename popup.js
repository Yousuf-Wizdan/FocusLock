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
  if (t.favIcon) return `<img src="${esc(t.favIcon)}" alt="" onerror="this.style.display='none'">`;
  const letter = (t.host || "?").charAt(0).toUpperCase();
  return `<span aria-hidden="true" style="width:16px;height:16px;border-radius:3px;background:#EDE6D3;color:#6B645A;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none">${esc(letter)}</span>`;
}

function phaseInfo(s) {
  const phases = Array.isArray(s.phases) ? s.phases : [{ type: "focus", minutes: s.plannedMinutes || 120 }];
  const idx = Math.min(s.phaseIndex || 0, phases.length - 1);
  const focuses = phases.filter((p) => p.type === "focus").length;
  const focusNo = phases.slice(0, idx + 1).filter((p) => p.type === "focus").length;
  return { phases, idx, cur: phases[idx], focuses, focusNo };
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
  const dot = $("dot");
  dot.className = "dot" + (live ? " live" : "");
  $("start").style.display = live ? "none" : "";
  $("stop").style.display = live ? "" : "none";

  if (live) {
    const s = session;
    const { phases, idx, cur, focuses, focusNo } = phaseInfo(s);
    const isBreak = cur.type === "break";
    const anchor = isBreak ? s.phaseEndsAt : s.endsAt;
    const denom = isBreak
      ? Math.max(1, s.phaseEndsAt - (s.phaseStartedAt || (s.phaseEndsAt - 10 * 60000)))
      : (s.endsAt - s.startedAt);

    dot.classList.toggle("rest", isBreak);
    $("phaseName").textContent = isBreak ? "Break" : focuses > 1 ? `Focus ${focusNo} of ${focuses}` : "Focus";
    $("phaseName").classList.toggle("rest", isBreak);
    document.querySelector(".rule").classList.toggle("rest", isBreak);
    $("sTimeK").textContent = isBreak ? "break left" : "session left";
    $("sTime").textContent = fmtClock(anchor - Date.now());
    $("sSwitch").textContent = switches;
    $("sUrge").textContent = (s.urgeLog || []).length;
    $("bar").style.width = Math.min(100, Math.max(0, ((denom - (anchor - Date.now())) / denom) * 100)) + "%";
    const endAt = new Date(s.endsAt);
    $("eta").textContent = `ends ${endAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

    const slog = (s.searchLog || []).filter((e) => Date.now() - e.at < 5 * 60000);
    $("searchLedger").textContent = `${slog.length} search${slog.length === 1 ? "" : "es"}`;

    const upcoming = phases.slice(idx + 1).map((p) => `${p.minutes}m ${p.type}`).join(" · ");
    const phaseLeft = fmtClock((s.phaseEndsAt || s.endsAt) - Date.now());
    $("phaseLine").innerHTML = isBreak
      ? `<div class="phase break">${phaseLeft} — step away from the screen.<span class="next">${upcoming ? "Then " + esc(upcoming) : ""} · switching free, blocks stay on</span></div>
         <div class="row" style="margin-top:6px"><button class="btn" id="skipBreak" style="background:transparent;border-color:#92400E;color:#92400E">Skip break</button></div>`
      : `<div class="phase">${phaseLeft} in this block.<span class="next">${upcoming ? "Then " + esc(upcoming) : "Final stretch — finish strong."}</span></div>`;
    const skipBtn = $("skipBreak");
    if (skipBtn) skipBtn.onclick = async () => {
      if (!confirm("Skip the break? Rest is when memory consolidates — skipping is logged.")) return;
      await chrome.runtime.sendMessage({ type: "SKIP_BREAK" });
      refresh();
    };

    const sbox = $("searchNote");
    if (slog.length >= 2) {
      const last = slog[slog.length - 1];
      sbox.style.display = "";
      sbox.textContent = `${slog.length} YouTube searches in 5 min${last && last.query ? ` — latest “${last.query}”` : ""}. ${slog.length >= 4 ? "Spiral risk: back to the lecture." : "Lecture-driven is fine; spirals aren't."}`;
    } else sbox.style.display = "none";

    $("planLine").textContent = `Plan: ${phases.map((p) => `${p.minutes}m ${p.type}`).join(" · ")}`;

    const tabs = s.studyTabs || [];
    $("pinCount").textContent = tabs.length ? `(${tabs.length})` : "";
    $("studyList").innerHTML = tabs.length
      ? tabs.map((t) => `
        <div class="studytab">
          ${tabIcon(t)}
          <div class="t">
            <b title="${esc(t.url || "")}">${esc(t.title || t.host || "Untitled tab")}</b>
            <span class="${t.closed ? "closed" : "ok"}">${t.closed ? "Closed — reopen it, then re-pin" : `${esc(t.host || "pinned")} · switching free`}</span>
          </div>
          <button data-unpin="${t.id}" title="Unpin this tab" aria-label="Unpin ${esc(t.title || t.host || "tab")}">×</button>
        </div>`).join("")
      : `<div class="empty">No study tabs pinned. Open your lecture tab, then pin it.</div>`;

    $("urges").innerHTML = (s.urgeLog || []).length
      ? s.urgeLog.slice(-6).reverse().map((u) => `
        <div class="urge">
          <div class="col"><b>${esc(u.text)}</b>${u.site ? `<div class="site">${esc(u.site)} — unlocks after session</div>` : ""}</div>
          <span class="ago">${ago(u.at)}</span>
        </div>`).join("")
      : `<div class="empty">Nothing parked. Name the urge instead of opening it.</div>`;
  } else {
    dot.classList.remove("rest");
    $("phaseName").textContent = "Ready";
    $("phaseName").classList.remove("rest");
    document.querySelector(".rule").classList.remove("rest");
    $("sTime").textContent = "–";
    $("sTimeK").textContent = "left";
    $("sSwitch").textContent = "0";
    $("sUrge").textContent = "0";
    $("searchLedger").textContent = "0 searches";
    $("bar").style.width = "0%";
    $("phaseLine").innerHTML = "";
    $("searchNote").style.display = "none";
    $("eta").textContent = "";
    $("planLine").textContent = "Study guard — watch stays open, Shorts and feed blocked";
    $("pinCount").textContent = "";
    $("studyList").innerHTML = `<div class="empty">Pin the tab you're studying in, then start. Switches between pinned tabs are never counted.</div>`;
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

function planText(minutes) {
  if (minutes <= 25) return `${minutes} min single block, no break. Start?`;
  if (minutes < 70) return `${minutes} min: 25 focus, 5 break, ${minutes - 30} focus. Start?`;
  return `${minutes} min: 50 focus, 10 break, ${minutes - 60} focus. Start?`;
}

async function startWith(minutes) {
  if (!confirm(planText(minutes))) return;
  const whitelist = $("whitelist").value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const meta = await curTabMeta();
  await chrome.runtime.sendMessage({
    type: "START_SESSION",
    minutes,
    whitelist,
    studyTabs: meta ? [meta] : [],
  });
  refresh();
}

$("start").onclick = async () => {
  startWith(Math.min(240, Math.max(15, parseInt($("minutes").value) || 25)));
};

document.querySelectorAll(".sprint").forEach((b) => {
  b.onclick = () => {
    const m = parseInt(b.dataset.min);
    $("minutes").value = m;
    startWith(m);
  };
});

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
  if (switches > 0 && !confirm(`End session with ${switches} tab switches? Nothing is saved against you.`)) return;
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
renderJournal();

// Lightweight 1s tick: countdown + progress bar only, no re-render (no flicker).
// During breaks the anchor is the break end; otherwise the session end.
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

// ---- spiral journal: streaks, streak discipline, top pulls ----
// Last 7 days, one row each. Bar = sessions that day (green done, tan quit
// early). Streak = consecutive days with at least one completed session.
// The point: your ladder is visible. Three 25s in a row earns the 50.
async function renderJournal() {
  let history = [];
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_HISTORY" });
    history = (res && res.history) || [];
  } catch { return; }
  if (!history.length) return;
  const wrap = $("journalwrap"), box = $("journal");
  wrap.style.display = "";

  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  const byDay = {};
  for (const h of history) {
    const k = dayKey(h.endedAt);
    (byDay[k] = byDay[k] || []).push(h);
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today - i * 86400000);
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    days.push({ d, list: byDay[k] || [] });
  }
  // Streak over trailing days: today may still be in progress, so start from
  // yesterday if today has no completed session yet.
  let streak = 0;
  const seq = days.map((x) => x.list.some((h) => h.completed));
  let idx = seq.length - 1;
  if (!seq[idx]) idx -= 1;
  for (; idx >= 0 && seq[idx]; idx--) streak++;

  const label = (d, i) => i === 6 ? "Today" : i === 5 ? "Yesterday"
    : d.toLocaleDateString(undefined, { weekday: "short" });
  box.innerHTML = days.map(({ d, list }, i) => {
    const done = list.filter((h) => h.completed).length;
    const quit = list.length - done;
    const n = list.length
      ? `${list.length} session${list.length > 1 ? "s" : ""} · ${done} done`
      : `rest`;
    const bars = list.length
      ? `<div class="bars" aria-hidden="true">${list.map((h) =>
          `<i class="${h.completed ? "done" : "quit"}" title="${h.planned} min, ${h.switches} switches"></i>`).join("")}</div>`
      : "";
    return `<div class="jday"><div class="top"><b>${label(d, i)}</b><span class="n">${n}</span></div>${bars}<div class="topsites"></div></div>`;
  }).join("") + (streak >= 2 ? `<div class="hint">Streak: ${streak} days with a finished session. Keep the ladder — don't jump lengths.</div>` : "");
  // Top pulls across the week, shown on today's row only.
  const counts = {};
  for (const h of history) for (const t of h.top || []) counts[t.site] = (counts[t.site] || 0) + t.count;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const rows = box.querySelectorAll(".jday .topsites");
  if (top.length && rows.length) {
    rows[rows.length - 1].innerHTML = `Pulls hardest: ${top.map(([s, c]) => `<b>${esc(s)}</b> ×${c}`).join(" · ")}`;
  }
}
