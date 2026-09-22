const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
    const total = Math.max(1, Math.round((session.endsAt - session.startedAt) / 60000));
    const left = Math.max(0, Math.round((session.endsAt - Date.now()) / 60000));
    $("sTime").textContent = left;
    $("sSwitch").textContent = switches;
    $("sUrge").textContent = (session.urgeLog || []).length;
    $("bar").style.width = Math.min(100, Math.max(0, ((total - left) / total) * 100)) + "%";

    const tabs = session.studyTabs || [];
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
    $("sSwitch").textContent = "0";
    $("sUrge").textContent = "0";
    $("bar").style.width = "0%";
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
  const whitelist = $("whitelist").value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const meta = await curTabMeta();
  await chrome.runtime.sendMessage({
    type: "START_SESSION",
    minutes: parseInt($("minutes").value) || 120,
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
setInterval(refresh, 15000);
