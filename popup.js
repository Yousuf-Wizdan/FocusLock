const $ = (id) => document.getElementById(id);

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  const session = st.session, switches = st.switches;
  if (session) {
    const mins = Math.max(0, Math.round((session.endsAt - Date.now()) / 60000));
    const pinned = (session.studyTabIds || []).length;
    $("status").innerHTML = `🟢 <b>${mins} min</b> left &nbsp;•&nbsp; ${switches} tab-switches<br><span style="color:#94a3b8;font-size:12px">Parked urges: ${(session.urgeLog || []).length} • study tabs: ${pinned}</span>`;
    $("urges").innerHTML = (session.urgeLog || []).slice(-6).reverse().map((u) => `<div>📌 ${escapeHtml(u.text)}</div>`).join("");
    $("studyTabs").textContent = pinned ? `📌 ${pinned} study tab${pinned > 1 ? "s" : ""} pinned — switches there are free` : "No study tabs pinned yet — open your lecture/video tab, open popup, hit pin.";
  } else {
    $("status").innerHTML = `⚪ No session. Open your study tab, pin it, then start.`;
    $("urges").innerHTML = "";
    $("studyTabs").textContent = "";
  }
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

$("start").onclick = async () => {
  const whitelist = $("whitelist").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ type: "START_SESSION", minutes: parseInt($("minutes").value) || 120, whitelist, studyTabIds: tab ? [tab.id] : [] });
  refresh();
};
$("pin").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ type: "PIN_STUDY_TAB", tabId: tab.id });
  if (!res.ok) {
    // no active session: start one with this tab pinned
    const whitelist = $("whitelist").value.split("\n").map((s) => s.trim()).filter(Boolean);
    await chrome.runtime.sendMessage({ type: "START_SESSION", minutes: parseInt($("minutes").value) || 120, whitelist, studyTabIds: [tab.id] });
  }
  refresh();
};
$("stop").onclick = async () => {
  const { switches } = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
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
