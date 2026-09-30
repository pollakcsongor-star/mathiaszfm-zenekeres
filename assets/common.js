// Pulse ENGINE · Zenekérés — közös segédfüggvények (mindkét oldal használja)
(function () {
  "use strict";

  const cfg = window.ZENE_CONFIG || {};
  const url = String(cfg.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = String(cfg.SUPABASE_KEY || "").trim();

  // A secret kulcs mindenhez hozzáfér. Ha véletlenül ide kerülne, a weboldal
  // inkább nem indul el, mint hogy nyilvánosan kiadja.
  function keyRole(k) {
    if (k.startsWith("sb_secret_")) return "secret";
    if (k.startsWith("sb_publishable_")) return "publishable";
    const parts = k.split(".");
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return payload.role === "service_role" ? "secret" : "publishable";
      } catch (e) { /* nem JWT */ }
    }
    return "unknown";
  }

  function setupProblem() {
    if (!url || !key) {
      return "A zenekérő még nincs beállítva: a config.js fájlba be kell írni a Supabase címét és a nyilvános (publishable / anon) kulcsát.";
    }
    // https kell; helyi próbához (localhost) a http is jó.
    if (!/^(https:\/\/[^/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(url)) {
      return "A config.js-ben a SUPABASE_URL nem jó formátumú (pl. https://abcdefgh.supabase.co).";
    }
    if (keyRole(key) === "secret") {
      return "A config.js-ben a SECRET (service_role) kulcs van! Ezt soha nem szabad a weboldalra tenni. Cseréld a nyilvános (publishable / anon) kulcsra.";
    }
    return "";
  }

  // PostgREST RPC-hívás fetch-csel (a zenekérő oldalnak nem kell a teljes Supabase könyvtár).
  async function rpc(name, args) {
    const headers = { "Content-Type": "application/json", apikey: key };
    // A régi (JWT) anon kulcsot Authorization fejlécben is várja az API;
    // az új publishable kulcshoz elég az apikey.
    if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
    let res;
    try {
      res = await fetch(url + "/rest/v1/rpc/" + name, {
        method: "POST", headers, body: JSON.stringify(args || {}),
      });
    } catch (e) {
      throw new Error("Nem sikerült elérni a szervert. Van internet?");
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = data && typeof data === "object" && data.message ? data.message : "Ismeretlen hiba (" + res.status + ")";
      throw new Error(msg);
    }
    return data;
  }

  // Kis DOM-építő: a felhasználótól jövő szöveg MINDIG textContent-ként kerül
  // az oldalra, sosem HTML-ként.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v; // csak saját, beégetett ikonokhoz!
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function toast(msg, type) {
    let stack = document.querySelector(".toast-stack");
    if (!stack) {
      stack = h("div", { class: "toast-stack", role: "status", "aria-live": "polite" });
      document.body.append(stack);
    }
    const t = h("div", { class: "toast" + (type ? " " + type : "") }, msg);
    stack.append(t);
    setTimeout(() => {
      t.classList.add("leaving");
      t.addEventListener("animationend", () => t.remove(), { once: true });
    }, type === "error" ? 5200 : 3400);
  }

  const rtf = new Intl.RelativeTimeFormat("hu", { numeric: "auto" });
  function timeAgo(iso) {
    if (!iso) return "";
    const diff = (new Date(iso).getTime() - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 60) return "az imént";
    if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
    if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
    return fmtDate(iso);
  }
  function fmtDate(iso, withTime) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString("hu-HU", { year: "numeric", month: "2-digit", day: "2-digit" }) +
      (withTime ? " " + d.toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" }) : "");
  }

  // Beégetett ikonok (saját SVG-k, nem felhasználói adat).
  const icons = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
    cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>',
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.4 3.5 2.1-.8 1.3L11 13V7h2v5.4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62A7.95 7.95 0 0 1 20.2 16l2.37-.78A10.5 10.5 0 0 0 12.5 8z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>',
    spotify: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 14.4a.62.62 0 0 1-.86.2c-2.35-1.43-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.21c3.81-.87 7.08-.5 9.72 1.11.3.18.39.57.21.86zm1.22-2.72a.78.78 0 0 1-1.07.26c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 1 1-.45-1.49c3.63-1.1 8.15-.57 11.23 1.33.37.22.48.7.26 1.07zm.1-2.83C14.7 8.93 9.38 8.75 6.3 9.69a.94.94 0 1 1-.54-1.8c3.53-1.07 9.4-.86 13.1 1.34a.94.94 0 0 1-.94 1.62z"/></svg>',
  };

  window.Z = { cfg, url, key, setupProblem, rpc, h, toast, timeAgo, fmtDate, icons };
})();
