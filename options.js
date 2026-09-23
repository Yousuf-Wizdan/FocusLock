/* FocusLock settings — GENERAL / FOCUS / SITES / DATA / ABOUT rail.
 * Same contracts: GET_STATUS, SAVE_SETTINGS, GET_BLOCKLIST, SET_BLOCKLIST,
 * CLEAR_HISTORY. Blocklist UI is a searchable row list with an inline add
 * dialog; domains validated before save (SW re-validates too). */
(function () {
  "use strict";
  const { toast, dialog, icon } = window.FL;
  const $ = (id) => document.getElementById(id);

  let allDefaults = [], activeDefaults = new Set(), customs = [];

  document.querySelectorAll("nav.rail button").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("nav.rail button").forEach((x) =>
        x.setAttribute("aria-selected", x === b ? "true" : "false"));
      document.querySelectorAll(".pane").forEach((p) =>
        p.classList.toggle("on", p.id === "pane-" + b.dataset.pane));
    };
  });

  // Theme applies live to this page (popup/pages read it from settings).
  function paintTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }

  async function load() {
    const st = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    const s = (st && st.settings) || {};
    $("themeSel").value = s.theme || "system";
    paintTheme(s.theme);
    $("defMin").value = s.defaultMinutes || 25;
    $("ytGuard").checked = s.youtubeGuard !== false;
    $("emPass").checked = s.emergencyPass !== false;
    $("allowList").value = (s.sessionAllowlist || []).join(", ");
    const bl = await chrome.runtime.sendMessage({ type: "GET_BLOCKLIST" });
    allDefaults = bl.allDefaults || [];
    activeDefaults = new Set(bl.defaults || []);
    customs = bl.customs || [];
    renderSites("");
    $("ver").textContent = "v" + (chrome.runtime.getManifest().version || "");
  }

  $("themeSel").onchange = async () => {
    paintTheme($("themeSel").value);
    await saveSoon();
  };
  $("defMin").onchange = saveSoon;
  $("ytGuard").onchange = saveSoon;
  $("emPass").onchange = saveSoon;
  $("allowList").onchange = saveSoon;

  let saveT = null;
  async function saveSoon() {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      const allow = $("allowList").value.split(/[,\\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
      await chrome.runtime.sendMessage({
        type: "SAVE_SETTINGS",
        settings: {
          theme: $("themeSel").value,
          defaultMinutes: Math.min(240, Math.max(5, parseInt($("defMin").value) || 25)),
          youtubeGuard: $("ytGuard").checked,
          emergencyPass: $("emPass").checked,
          sessionAllowlist: allow,
        },
      });
      toast("Settings saved");
    }, 350);
  }

  // ---------- blocklist rows ----------
  function validDomain(d) {
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(d);
  }

  function renderSites(filter) {
    const box = $("siteList");
    const f = (filter || "").toLowerCase();
    const rows = [];
    for (const d of allDefaults) {
      if (f && !d.includes(f)) continue;
      const on = activeDefaults.has(d);
      rows.push({ domain: d, on, builtin: true });
    }
    for (const d of customs) {
      if (f && !d.includes(f)) continue;
      rows.push({ domain: d, on: true, builtin: false });
    }
    box.innerHTML = rows.length ? "" : `<div class="empty">No sites match “${filter}”.</div>`;
    for (const r of rows) {
      const div = document.createElement("div");
      div.className = "site-item";
      const grow = document.createElement("div");
      grow.className = "grow";
      grow.textContent = r.domain;
      grow.style.opacity = r.on ? "1" : "0.5";
      const st = document.createElement("span");
      st.className = "badge" + (r.on ? " on" : "");
      st.textContent = r.on ? "Paused" : "Off";
      const btn = document.createElement("button");
      btn.className = "icon-btn";
      btn.setAttribute("aria-label", (r.on ? "Turn off " : "Turn on ") + r.domain);
      btn.innerHTML = icon(r.on ? "x" : "plus");
      btn.onclick = () => {
        if (r.builtin) {
          if (r.on) activeDefaults.delete(r.domain);
          else activeDefaults.add(r.domain);
        } else {
          customs = customs.filter((c) => c !== r.domain);
        }
        persistBlocklist();
        renderSites($("siteSearch").value);
      };
      div.appendChild(grow);
      div.appendChild(st);
      div.appendChild(btn);
      box.appendChild(div);
    }
  }

  $("siteSearch").oninput = () => renderSites($("siteSearch").value);
  $("addBtn").onclick = () => {
    $("addBox").hidden = false;
    $("newSite").value = "";
    $("newSite").focus();
  };
  $("cancelAdd").onclick = () => { $("addBox").hidden = true; };
  $("confirmAdd").onclick = addSite;
  $("newSite").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSite();
    if (e.key === "Escape") $("addBox").hidden = true;
  });

  function addSite() {
    let d = $("newSite").value.trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    if (!validDomain(d)) {
      toast("Enter a valid domain like example.com");
      $("newSite").focus();
      return;
    }
    if (allDefaults.includes(d)) activeDefaults.add(d);
    else if (!customs.includes(d)) customs.push(d);
    $("addBox").hidden = true;
    persistBlocklist();
    renderSites($("siteSearch").value);
    toast("Site added");
  }

  async function persistBlocklist() {
    await chrome.runtime.sendMessage({
      type: "SET_BLOCKLIST",
      customs,
      defaults: allDefaults.filter((d) => activeDefaults.has(d)),
    });
  }

  $("clearHist").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
    toast("Session history cleared");
  };

  $("resetAll").onclick = () => {
    dialog({
      title: "Reset everything?",
      bodyHTML: `<p class="hint">This erases sessions, study tabs, urges, history, blocklist changes and settings on this device.</p>`,
      actions: [
        { label: "Keep my data", kind: "primary" },
        { label: "Erase everything", kind: "danger", onClick: async () => {
          await chrome.storage.local.clear();
          location.reload();
        } },
      ],
    });
  };

  load();
})();
