// Pulse ENGINE · Zenekérés — admin (stúdió) felület
(function () {
  "use strict";
  const { h, toast, icons, timeAgo, fmtDate } = Z;
  const $ = (s) => document.querySelector(s);

  const TABS = ["review", "good", "bad", "playlists"];
  const HASH = { review: "#biralas", good: "#jo", bad: "#elutasitva", playlists: "#listak" };
  const PAGE = 150;

  const state = {
    tab: tabFromHash() || "review",
    pending: null,          // bírálandó csoportok
    songs: null,            // minden elbírált zene
    playlists: null,
    songKeyParts: [],       // hasonlóság-kereséshez előre felbontott kulcsok
    edits: {},              // norm_key -> { artist, title } (javított írásmód)
    busy: new Set(),        // éppen mentés alatt álló sorok
    selected: new Set(),    // lejátszási listához kijelölt zene-azonosítók
    goodQuery: "", badQuery: "",
    goodSort: "requests", onlyNew: false,
    goodLimit: PAGE, badLimit: PAGE,
    plName: "",
    dialog: null,           // { mode: "add" | "edit", song }
    tick: 0,
  };

  // ------------------------------------------------------------------ indulás
  const problem = Z.setupProblem() ||
    (window.supabase ? "" : "Nem sikerült betölteni a Supabase könyvtárat. Van internet? Frissítsd az oldalt.");
  if (problem) {
    const w = $("#setup-warning");
    w.textContent = problem;
    w.classList.remove("hidden");
    $("#login-btn").disabled = true;
    return;
  }

  const sb = window.supabase.createClient(Z.url, Z.key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "pulse-zenekeres-admin" },
  });

  async function call(name, args) {
    const { data, error } = await sb.rpc(name, args || {});
    if (error) {
      if (/jwt expired|invalid jwt/i.test(error.message || "")) {
        await sb.auth.signOut();
        throw new Error("Lejárt a belépés, lépj be újra.");
      }
      throw new Error(error.message || "Ismeretlen hiba");
    }
    return data;
  }

  // A callbackben nem szabad más Supabase-hívásra várni (a könyvtár ilyenkor
  // megakadhat), ezért csak a felületet váltjuk.
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") showLogin();
  });

  boot();

  async function boot() {
    const { data } = await sb.auth.getSession();
    if (data && data.session) await enter();
    else showLogin();
  }

  // ------------------------------------------------------------------ belépés
  function showLogin(message) {
    stopAutoRefresh();
    $("#app-view").classList.add("hidden");
    $("#select-bar").classList.add("hidden");
    $("#login-view").classList.remove("hidden");
    $("#login-form").classList.remove("hidden");
    const msg = $("#login-msg");
    msg.replaceChildren();
    msg.classList.toggle("hidden", !message);
    if (message) msg.append(message);
  }

  function showNotAdmin(email) {
    $("#app-view").classList.add("hidden");
    $("#login-view").classList.remove("hidden");
    $("#login-form").classList.add("hidden");
    const msg = $("#login-msg");
    msg.replaceChildren(
      "Be vagy jelentkezve (", h("b", {}, email || "ismeretlen"), "), de ez a fiók nincs az adminok között. ",
      "A Supabase SQL Editorban futtasd le ezt, majd frissítsd az oldalt:",
      h("code", {}, "insert into public.admins (email) values ('" + String(email || "").replace(/'/g, "''") + "');"),
      h("div", { style: "margin-top:14px" },
        h("button", { class: "btn", type: "button", onclick: () => sb.auth.signOut() }, "Kijelentkezés"))
    );
    msg.classList.remove("hidden");
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#login-btn");
    const email = $("#email").value.trim();
    const password = $("#password").value;
    if (!email || !password) { showLogin("Add meg az e-mail-címed és a jelszavad."); return; }
    btn.disabled = true;
    btn.replaceChildren(h("span", { class: "spinner" }), "Belépés…");
    try {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        showLogin(/invalid login|invalid credentials/i.test(error.message)
          ? "Hibás e-mail-cím vagy jelszó."
          : error.message);
        return;
      }
      $("#password").value = "";
      await enter();
    } finally {
      btn.disabled = false;
      btn.textContent = "Belépés";
    }
  });

  $("#logout-btn").addEventListener("click", () => sb.auth.signOut());

  async function enter() {
    let who;
    try {
      who = await call("admin_whoami");
    } catch (e) {
      showLogin(e.message);
      return;
    }
    if (!who || !who.is_admin) {
      showNotAdmin(who && who.email);
      return;
    }
    $("#login-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
    $("#user-name").textContent = who.email;
    $("#avatar").textContent = (who.email || "?").charAt(0).toUpperCase();
    render();
    await reload(["pending", "songs", "playlists"]);
    startAutoRefresh();
  }

  // ------------------------------------------------------------------ adatok
  const loaders = {
    pending: async () => { state.pending = await call("admin_pending"); },
    songs: async () => {
      state.songs = await call("admin_songs");
      state.songKeyParts = state.songs.map((s) => ({ song: s, parts: (s.keys || []).map(splitKey) }));
      const ids = new Set(state.songs.filter((s) => s.verdict === "good").map((s) => s.id));
      for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
    },
    playlists: async () => { state.playlists = await call("admin_playlists"); },
  };

  async function reload(which, opts) {
    const results = await Promise.allSettled(which.map((w) => loaders[w]()));
    const failed = results.find((r) => r.status === "rejected");
    if (failed && !(opts && opts.quiet)) toast(failed.reason.message, "error");
    safeRender();
  }

  // Automatikus frissítés: új kérések és a Pulse visszajelzése.
  let timer = null;
  function startAutoRefresh() {
    stopAutoRefresh();
    timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      state.tick++;
      const which = ["pending", "playlists"];
      if (state.tick % 5 === 0) which.push("songs");
      reload(which, { quiet: true });
    }, 30000);
  }
  function stopAutoRefresh() { if (timer) clearInterval(timer); timer = null; }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && timer) reload(["pending", "playlists"], { quiet: true });
  });

  // ------------------------------------------------------------------ hasonlóság
  // Elgépelésekhez (pl. "trainign season"): két szöveg betűpárjainak átfedése.
  function bigrams(s) {
    const t = " " + s + " ";
    const m = new Map();
    for (let i = 0; i < t.length - 1; i++) {
      const b = t.slice(i, i + 2);
      m.set(b, (m.get(b) || 0) + 1);
    }
    return m;
  }
  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    let inter = 0, n = 0;
    for (const [k, v] of A) { n += v; if (B.has(k)) inter += Math.min(v, B.get(k)); }
    for (const v of B.values()) n += v;
    return (2 * inter) / n;
  }
  function splitKey(k) {
    const i = k.indexOf(" | ");
    return i < 0 ? ["", k] : [k.slice(0, i), k.slice(i + 3)];
  }
  function findSimilar(key) {
    const [ka, kt] = splitKey(key);
    const out = [];
    for (const { song, parts } of state.songKeyParts) {
      let best = 0;
      for (const [sa, st] of parts) {
        const ts = dice(kt, st);
        if (ts < 0.5) continue;
        best = Math.max(best, 0.35 * dice(ka, sa) + 0.65 * ts);
      }
      if (best >= 0.62) out.push({ song, score: best });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 2);
  }

  // ------------------------------------------------------------------ fülek
  function tabFromHash() {
    const found = Object.entries(HASH).find(([, v]) => v === location.hash);
    return found ? found[0] : null;
  }
  window.addEventListener("hashchange", () => {
    const t = tabFromHash();
    if (t && t !== state.tab) { state.tab = t; render(); }
  });
  $("#nav").addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-btn");
    if (!btn || !TABS.includes(btn.dataset.tab)) return;
    setTab(btn.dataset.tab);
  });
  function setTab(tab) {
    state.tab = tab;
    if (location.hash !== HASH[tab]) history.replaceState(null, "", HASH[tab]);
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Ha épp egy kérés írásmódját javítod, a háttérfrissítés nem rajzolja újra
  // a listát (elveszne a kurzor); a következő frissítéskor pótolja.
  function safeRender() {
    const a = document.activeElement;
    const typing = a && (a.classList.contains("inline-input") ||
      (a.closest && a.closest(".toolbar")) || a.id === "pl-name");
    if (typing) { updateBadges(); return; }
    render();
  }

  function render() {
    updateBadges();
    document.querySelectorAll(".nav-btn").forEach((b) => {
      const on = b.dataset.tab === state.tab;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    const panel = $("#panel");
    panel.replaceChildren();
    if (state.tab === "review") renderReview(panel);
    else if (state.tab === "good") renderSongsTab(panel, "good");
    else if (state.tab === "bad") renderSongsTab(panel, "bad");
    else renderPlaylists(panel);
    updateSelectBar();
  }

  function updateBadges() {
    const set = (id, n, hot) => {
      const b = $(id);
      b.textContent = n === null ? "·" : String(n);
      b.classList.toggle("hot", !!hot && n > 0);
    };
    set("#b-review", state.pending ? state.pending.length : null, true);
    set("#b-good", state.songs ? state.songs.filter((s) => s.verdict === "good").length : null);
    set("#b-bad", state.songs ? state.songs.filter((s) => s.verdict === "bad").length : null);
    set("#b-pl", state.playlists ? state.playlists.filter((p) => p.status !== "done").length : null);
    const n = state.pending ? state.pending.length : 0;
    document.title = (n ? "(" + n + ") " : "") + "Zenekérés · Stúdió";
  }

  // ------------------------------------------------------------------ közös darabok
  function ico(svg) { return h("span", { html: svg, style: "display:contents" }); }
  function btn(icon, label, onclick, cls) {
    return h("button", { class: cls || "btn", type: "button", onclick }, icon ? ico(icon) : null, label);
  }
  function iconBtn(icon, label, onclick, danger) {
    return h("button", { class: "icon-btn" + (danger ? " danger" : ""), type: "button", title: label, "aria-label": label, onclick }, ico(icon));
  }
  function hint(...text) { return h("div", { class: "hint" }, ico(icons.info), h("div", {}, ...text)); }
  function loading() { return h("div", { class: "loading" }, h("span", { class: "spinner" }), "Betöltés…"); }
  function empty(big, small) { return h("div", { class: "empty" }, h("div", { class: "big" }, big), small); }
  function verdictChip(v) { return h("span", { class: "chip " + v }, v === "good" ? "Jó" : "Nem jó"); }
  function head(eyebrow, title, sub, actions) {
    return h("div", { class: "panel-head" },
      h("div", {},
        h("div", { class: "eyebrow" }, eyebrow),
        h("h2", { class: "section-title", style: "margin-top:8px" }, title),
        sub ? h("div", { class: "sub" }, sub) : null),
      h("div", { class: "panel-actions" }, actions));
  }
  function plural(n, word) { return n + " " + word; }

  // ------------------------------------------------------------------ Bírálás
  function renderReview(panel) {
    const list = state.pending;
    const total = list ? list.reduce((a, g) => a + g.count, 0) : 0;
    const card = h("div", { class: "card" },
      head("Zenekérés", "Bírálásra vár",
        list ? (list.length ? plural(list.length, "zene") + " · " + plural(total, "kérés") : "Nincs új kérés") : "Betöltés…",
        [btn(icons.plus, "Zene felvétele", () => openDialog("add")),
         btn(icons.refresh, "Frissítés", () => reload(["pending", "songs"]))]),
      hint("Amiről egyszer döntöttél, arra a rendszer emlékszik: ha valaki újra kéri – akár kisbetűvel, ékezet nélkül vagy „(Official Video)”-val –, automatikusan jó vagy nem jó lesz. ",
           "Döntés előtt kijavíthatod az előadót és a címet; a javított és az eredeti írásmód is megjegyződik."));

    if (!list) card.append(loading());
    else if (!list.length) card.append(empty("Minden kérés elbírálva", "Amint új kérés érkezik, itt jelenik meg."));
    else card.append(h("div", { class: "review-list" }, list.map(reviewRow)));
    panel.append(card);
    fitAllInputs();
  }

  // A szerkeszthető előadó/cím mező pont akkora legyen, mint a szöveg.
  // Új böngészőkben ezt a CSS (field-sizing) megoldja, régebbiekben kimérjük.
  const FIELD_SIZING = !!(window.CSS && CSS.supports && CSS.supports("field-sizing", "content"));
  const measureCtx = document.createElement("canvas").getContext("2d");
  function fitInput(el) {
    if (FIELD_SIZING || !el.isConnected) return;
    const cs = getComputedStyle(el);
    measureCtx.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    const w = measureCtx.measureText(el.value || " ").width;
    el.style.width = Math.ceil(w + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 4) + "px";
  }
  function fitAllInputs() { document.querySelectorAll(".inline-input").forEach(fitInput); }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAllInputs);

  function reviewRow(g) {
    const key = g.norm_key;
    const edit = state.edits[key] || { artist: g.artist, title: g.title };
    const busy = state.busy.has(key);

    const artistIn = h("input", { class: "inline-input artist", value: edit.artist, maxlength: 120, "aria-label": "Előadó", spellcheck: "false" });
    const titleIn = h("input", { class: "inline-input", value: edit.title, maxlength: 160, "aria-label": "Cím", spellcheck: "false" });
    const onEdit = () => {
      state.edits[key] = { artist: artistIn.value, title: titleIn.value };
      fitInput(artistIn);
      fitInput(titleIn);
    };
    artistIn.addEventListener("input", onEdit);
    titleIn.addEventListener("input", onEdit);
    [artistIn, titleIn].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); }));

    const who = g.requesters || [];
    const meta = h("div", { class: "meta" },
      who.length ? ["Kérte: ", h("b", {}, who.slice(0, 4).join(", ")), who.length > 4 ? " és még " + (who.length - 4) : "", " · "] : null,
      g.count > 1 ? "először " + timeAgo(g.first_at) + ", utoljára " + timeAgo(g.last_at) : timeAgo(g.last_at));

    const row = h("article", { class: "review" });
    const sims = findSimilar(key).map(({ song }) =>
      h("div", { class: "similar" },
        "Hasonló, már elbírált: ", h("b", {}, song.artist + " – " + song.title), verdictChip(song.verdict),
        h("button", { class: "btn small", type: "button", disabled: busy, onclick: () => linkGroup(g, song, row) }, "Ugyanaz")));

    row.append(
      h("div", { class: "count" + (g.count > 1 ? " multi" : ""), title: plural(g.count, "kérés") }, String(g.count), h("small", {}, "kérés")),
      h("div", { class: "body" }, h("div", { class: "edit-row" }, artistIn, h("span", { class: "dash" }, "–"), titleIn), meta, sims),
      h("div", { class: "actions" },
        h("button", { class: "btn-ok", type: "button", disabled: busy, onclick: () => decide(g, "good", row) }, ico(icons.check), "Jó"),
        h("button", { class: "btn-bad", type: "button", disabled: busy, onclick: () => decide(g, "bad", row) }, ico(icons.cross), "Nem jó"),
        iconBtn(icons.trash, "Törlés döntés nélkül (pl. értelmetlen kérés)", () => deleteGroup(g, row), true)));
    return row;
  }

  function setRowBusy(row, key, busy) {
    if (busy) state.busy.add(key); else state.busy.delete(key);
    row.querySelectorAll("button").forEach((b) => { b.disabled = busy; });
  }

  // A sort kiúsztatja, kiveszi a listából, és frissíti a többit.
  function removeRow(row, key, alsoReloadPending) {
    state.pending = (state.pending || []).filter((x) => x.norm_key !== key);
    delete state.edits[key];
    state.busy.delete(key);
    row.classList.add("leaving");
    const done = () => reload(alsoReloadPending ? ["pending", "songs"] : ["songs"]);
    row.addEventListener("animationend", done, { once: true });
    setTimeout(() => { if (row.isConnected) done(); }, 600);
    updateBadges();
  }

  async function decide(g, verdict, row) {
    const e = state.edits[g.norm_key] || g;
    const artist = (e.artist || "").trim(), title = (e.title || "").trim();
    if (!artist || !title) { toast("Az előadó és a cím nem lehet üres.", "error"); return; }
    setRowBusy(row, g.norm_key, true);
    try {
      const r = await call("admin_decide", { p_norm_key: g.norm_key, p_verdict: verdict, p_artist: artist, p_title: title });
      toast((verdict === "good" ? "Jó – megjegyezve: " : "Nem jó – megjegyezve: ") + artist + " – " + title,
        verdict === "good" ? "success" : undefined);
      // Ha a javított írásmód egy másik várakozó kéréssel is egyezett, az is elbírálódott.
      removeRow(row, g.norm_key, r && r.requests > g.count);
    } catch (ex) {
      setRowBusy(row, g.norm_key, false);
      toast(ex.message, "error");
    }
  }

  async function linkGroup(g, song, row) {
    setRowBusy(row, g.norm_key, true);
    try {
      const r = await call("admin_link", { p_norm_key: g.norm_key, p_song_id: song.id });
      toast("Összekötve: " + song.artist + " – " + song.title + " (" + (r.verdict === "good" ? "jó" : "nem jó") + ")",
        r.verdict === "good" ? "success" : undefined);
      removeRow(row, g.norm_key, false);
    } catch (ex) {
      setRowBusy(row, g.norm_key, false);
      toast(ex.message, "error");
    }
  }

  async function deleteGroup(g, row) {
    const ok = confirm("Törlöd döntés nélkül?\n\n" + g.artist + " – " + g.title + " (" + plural(g.count, "kérés") + ")\n\n" +
      "Értelmetlen, szemét kéréseknél hasznos. Ha a zenéről döntést akarsz, inkább a „Nem jó” gombot használd, mert arra a rendszer emlékszik.");
    if (!ok) return;
    setRowBusy(row, g.norm_key, true);
    try {
      await call("admin_delete_pending", { p_norm_key: g.norm_key });
      toast("Törölve.");
      removeRow(row, g.norm_key, false);
    } catch (ex) {
      setRowBusy(row, g.norm_key, false);
      toast(ex.message, "error");
    }
  }

  // ------------------------------------------------------------------ Jó zenék / Elutasítva
  function norm(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
  const collator = new Intl.Collator("hu");
  const time = (iso) => (iso ? new Date(iso).getTime() : 0);

  function songsOf(verdict) {
    if (!state.songs) return null;
    const q = norm(verdict === "good" ? state.goodQuery : state.badQuery).trim();
    let list = state.songs.filter((s) => s.verdict === verdict);
    if (q) list = list.filter((s) => norm(s.artist + " " + s.title + " " + (s.note || "")).includes(q));
    if (verdict === "good" && state.onlyNew) list = list.filter((s) => !s.playlist_count);
    const sort = verdict === "good" ? state.goodSort : "decided";
    const by = {
      requests: (a, b) => b.request_count - a.request_count || time(b.last_requested) - time(a.last_requested),
      recent: (a, b) => time(b.last_requested || b.decided_at) - time(a.last_requested || a.decided_at),
      decided: (a, b) => time(b.decided_at) - time(a.decided_at),
      abc: (a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title),
    }[sort];
    return list.slice().sort(by);
  }

  function renderSongsTab(panel, verdict) {
    const isGood = verdict === "good";
    const all = state.songs ? state.songs.filter((s) => s.verdict === verdict) : null;
    const card = h("div", { class: "card" });

    card.append(head(isGood ? "Elbírált · jó" : "Elbírált · nem jó",
      isGood ? "Jó zenék" : "Elutasított zenék",
      all ? plural(all.length, "zene") : "Betöltés…",
      isGood
        ? [btn(icons.plus, "Zene felvétele", () => openDialog("add")), btn(icons.download, "CSV", exportCsv)]
        : [btn(icons.plus, "Zene felvétele", () => openDialog("add", null, "bad"))]));

    card.append(isGood
      ? hint("Pipáld ki, amiket a lejátszási listába szeretnél, alul add meg a lista nevét, és állítsd össze. ",
             "Utána a Pulse szoftverben a ", h("b", {}, "Zene Kérések"), " menüben egy gombnyomással létrejön a Spotify-on.")
      : hint("Ezeket a rendszer automatikusan elutasítja, ha újra kérik. Ha meggondolod magad, a „Mégis jó” gombbal átteheted a jók közé."));

    const search = h("input", {
      class: "input", type: "search", placeholder: "Keresés előadóra, címre…", "aria-label": "Keresés",
      value: isGood ? state.goodQuery : state.badQuery,
    });
    search.addEventListener("input", () => {
      if (isGood) { state.goodQuery = search.value; state.goodLimit = PAGE; }
      else { state.badQuery = search.value; state.badLimit = PAGE; }
      renderList();
    });
    const toolbar = h("div", { class: "toolbar" }, search);

    let selectAll = null;
    if (isGood) {
      const sort = h("select", { class: "select", "aria-label": "Rendezés" },
        [["requests", "Legtöbbet kért elöl"], ["recent", "Legutóbb kért elöl"], ["decided", "Legutóbb bírált elöl"], ["abc", "ABC szerint"]]
          .map(([v, t]) => h("option", { value: v, selected: state.goodSort === v }, t)));
      sort.addEventListener("change", () => { state.goodSort = sort.value; renderList(); });
      const onlyNew = h("input", { type: "checkbox", checked: state.onlyNew });
      onlyNew.addEventListener("change", () => { state.onlyNew = onlyNew.checked; state.goodLimit = PAGE; renderList(); });
      toolbar.append(sort, h("label", { class: "toggle" }, onlyNew, "Még nem volt listán"));

      selectAll = h("input", { type: "checkbox", class: "check", "aria-label": "Mind kijelölése" });
      selectAll.addEventListener("change", () => {
        const list = songsOf("good") || [];
        if (selectAll.checked) list.forEach((s) => state.selected.add(s.id));
        else list.forEach((s) => state.selected.delete(s.id));
        renderList();
        updateSelectBar();
      });
    }
    card.append(toolbar);

    const selectAllRow = isGood ? h("label", { class: "select-all" }, selectAll, h("span", {})) : null;
    const listWrap = h("div", {});
    if (selectAllRow) card.append(selectAllRow);
    card.append(listWrap);
    panel.append(card);

    function renderList() {
      const list = songsOf(verdict);
      listWrap.replaceChildren();
      if (!list) { listWrap.append(loading()); return; }
      if (selectAllRow) {
        const nSel = list.filter((s) => state.selected.has(s.id)).length;
        selectAll.checked = list.length > 0 && nSel === list.length;
        selectAll.indeterminate = nSel > 0 && nSel < list.length;
        selectAllRow.lastChild.textContent = "Mind kijelölése (" + list.length + ")";
        selectAllRow.classList.toggle("hidden", !list.length);
      }
      if (!list.length) {
        const q = isGood ? state.goodQuery : state.badQuery;
        listWrap.append(q || (isGood && state.onlyNew)
          ? empty("Nincs találat", "Próbálj más keresést.")
          : empty(isGood ? "Még nincs jó zene" : "Még nincs elutasított zene", "A Bírálás fülön elbírált zenék kerülnek ide."));
        return;
      }
      const limit = isGood ? state.goodLimit : state.badLimit;
      listWrap.append(h("div", { class: "song-list" }, list.slice(0, limit).map((s) => songRow(s, isGood, renderList))));
      if (list.length > limit) {
        listWrap.append(h("button", {
          class: "btn more-btn", type: "button",
          onclick: () => { if (isGood) state.goodLimit += PAGE; else state.badLimit += PAGE; renderList(); },
        }, "További " + Math.min(PAGE, list.length - limit) + " megjelenítése (" + (list.length - limit) + " van még)"));
      }
    }
    renderList();
  }

  function songRow(s, selectable, rerender) {
    const selected = state.selected.has(s.id);
    const stats = h("div", { class: "stats" },
      h("span", { class: "stat" + (s.request_count >= 3 ? " hot" : ""), title: s.last_requested ? "Utoljára kérték: " + fmtDate(s.last_requested, true) : "" },
        s.request_count ? s.request_count + "× kérték" : "kézzel felvéve"),
      selectable && s.playlist_count ? h("span", { class: "stat" }, s.playlist_count + " listán") : null,
      selectable && !s.playlist_count ? h("span", { class: "chip wait" }, "új") : null);

    const actions = h("div", { class: "row-actions" },
      iconBtn(icons.edit, "Szerkesztés", () => openDialog("edit", s)),
      s.verdict === "good"
        ? iconBtn(icons.cross, "Mégsem jó (áttesz az elutasítottak közé)", () => setVerdict(s, "bad"), true)
        : iconBtn(icons.check, "Mégis jó (áttesz a jók közé)", () => setVerdict(s, "good")),
      iconBtn(icons.undo, "Újrabírálás (a döntés törlődik, a kérései visszakerülnek a Bírálás fülre)", () => reopen(s)));

    const info = h("div", { class: "info" },
      h("div", { class: "t" }, s.title),
      h("div", { class: "a" }, s.artist),
      s.note ? h("div", { class: "note" }, s.note) : null);

    if (!selectable) return h("div", { class: "song-row plain" }, info, stats, actions);

    const cb = h("input", { type: "checkbox", class: "check", checked: selected, "aria-label": "Kijelölés: " + s.artist + " – " + s.title });
    const row = h("div", { class: "song-row selectable" + (selected ? " selected" : "") }, cb, info, stats, actions);
    const toggle = (on) => {
      if (on) state.selected.add(s.id); else state.selected.delete(s.id);
      row.classList.toggle("selected", on);
      cb.checked = on;
      updateSelectBar();
      rerender && syncSelectAll();
    };
    cb.addEventListener("change", () => toggle(cb.checked));
    row.addEventListener("click", (e) => {
      if (e.target.closest("button, input, a")) return;
      toggle(!state.selected.has(s.id));
    });
    return row;
  }

  function syncSelectAll() {
    const sa = document.querySelector(".select-all input");
    if (!sa) return;
    const list = songsOf("good") || [];
    const nSel = list.filter((s) => state.selected.has(s.id)).length;
    sa.checked = list.length > 0 && nSel === list.length;
    sa.indeterminate = nSel > 0 && nSel < list.length;
  }

  async function setVerdict(s, verdict) {
    try {
      await call("admin_set_verdict", { p_song_id: s.id, p_verdict: verdict });
      state.selected.delete(s.id);
      toast((verdict === "good" ? "Áttéve a jók közé: " : "Áttéve az elutasítottak közé: ") + s.artist + " – " + s.title,
        verdict === "good" ? "success" : undefined);
      await reload(["songs"]);
    } catch (ex) { toast(ex.message, "error"); }
  }

  async function reopen(s) {
    const ok = confirm("Újrabírálás?\n\n" + s.artist + " – " + s.title + "\n\n" +
      "A döntés és a megjegyzett írásmódok törlődnek, a zene kérései visszakerülnek a Bírálás fülre, " +
      "és a korábbi lejátszási listák nyilvántartásából is kikerül.");
    if (!ok) return;
    try {
      await call("admin_reopen_song", { p_song_id: s.id });
      state.selected.delete(s.id);
      toast("Visszatéve bírálásra: " + s.artist + " – " + s.title);
      await reload(["songs", "pending", "playlists"]);
    } catch (ex) { toast(ex.message, "error"); }
  }

  function exportCsv() {
    const list = songsOf("good") || [];
    const esc = (v) => '"' + String(v === null || v === undefined ? "" : v).replace(/"/g, '""') + '"';
    const rows = [["Előadó", "Cím", "Kérések", "Utoljára kérték", "Listákon", "Megjegyzés"]]
      .concat(list.map((s) => [s.artist, s.title, s.request_count, s.last_requested ? fmtDate(s.last_requested, true) : "", s.playlist_count, s.note || ""]));
    const csv = "﻿" + rows.map((r) => r.map(esc).join(";")).join("\r\n");
    const a = h("a", {
      href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })),
      download: "jo-zenek-" + new Date().toISOString().slice(0, 10) + ".csv",
    });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ------------------------------------------------------------------ Kijelölés-sáv
  function defaultPlName() {
    const d = new Date();
    return "Kérések – " + d.toLocaleDateString("hu-HU", { month: "long", day: "numeric" });
  }
  function updateSelectBar() {
    const bar = $("#select-bar");
    const show = state.tab === "good" && state.selected.size > 0 && !$("#app-view").classList.contains("hidden");
    bar.classList.toggle("hidden", !show);
    $("#sel-count").textContent = String(state.selected.size);
    const nameIn = $("#pl-name");
    if (show && !nameIn.value) nameIn.value = state.plName || defaultPlName();
  }
  $("#pl-name").addEventListener("input", (e) => { state.plName = e.target.value; });
  $("#pl-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#pl-create").click(); });
  $("#sel-clear").addEventListener("click", () => {
    state.selected.clear();
    render();
  });
  $("#pl-create").addEventListener("click", async () => {
    const name = $("#pl-name").value.trim();
    if (!name) { toast("Adj nevet a lejátszási listának.", "error"); $("#pl-name").focus(); return; }
    // A lista sorrendje a "Jó zenék" aktuális rendezését követi.
    const order = state.songs.filter((s) => s.verdict === "good").sort({
      requests: (a, b) => b.request_count - a.request_count,
      recent: (a, b) => time(b.last_requested || b.decided_at) - time(a.last_requested || a.decided_at),
      decided: (a, b) => time(b.decided_at) - time(a.decided_at),
      abc: (a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title),
    }[state.goodSort]);
    const ids = order.filter((s) => state.selected.has(s.id)).map((s) => s.id);
    const button = $("#pl-create");
    button.disabled = true;
    try {
      const r = await call("admin_create_playlist", { p_name: name, p_song_ids: ids });
      toast("„" + name + "” összeállítva (" + plural(r.count, "zene") + "). A Pulse-ban: Zene Kérések → Listák lekérése.", "success");
      state.selected.clear();
      state.plName = "";
      $("#pl-name").value = "";
      await reload(["playlists", "songs"]);
      setTab("playlists");
    } catch (ex) {
      toast(ex.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  // ------------------------------------------------------------------ Listák
  function renderPlaylists(panel) {
    const list = state.playlists;
    const card = h("div", { class: "card" },
      head("Spotify", "Lejátszási listák",
        list ? plural(list.length, "lista") : "Betöltés…",
        [btn(icons.refresh, "Frissítés", () => reload(["playlists"]))]),
      hint("Az itt látható listákat a Pulse szoftver hozza létre a Spotify-on: ",
           h("b", {}, "Zene Kérések"), " menü → ", h("b", {}, "Listák lekérése"), " → ", h("b", {}, "Létrehozás a Spotify-on"),
           ". Amíg ez nem történik meg, a lista „Pulse-ra vár”."));

    if (!list) card.append(loading());
    else if (!list.length) card.append(empty("Még nincs lista", "A Jó zenék fülön pipáld ki a zenéket, és állíts össze egyet."));
    else card.append(h("div", { class: "pl-list" }, list.map(playlistCard)));
    panel.append(card);
  }

  function playlistCard(p) {
    const items = p.items || [];
    const chip = p.status === "done"
      ? h("span", { class: "chip good" }, "Kész")
      : p.status === "error" ? h("span", { class: "chip bad" }, "Hiba") : h("span", { class: "chip wait" }, "Pulse-ra vár");
    return h("div", { class: "pl-card" },
      h("div", { class: "pl-top" },
        h("div", {},
          h("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" }, h("span", { class: "pl-name" }, p.name), chip),
          h("div", { class: "pl-meta" },
            plural(items.length, "zene") + " · összeállítva " + fmtDate(p.created_at, true) +
            (p.processed_at ? " · feldolgozva " + fmtDate(p.processed_at, true) : ""))),
        h("div", { class: "pl-actions" },
          p.spotify_url ? h("a", { class: "btn", href: p.spotify_url, target: "_blank", rel: "noopener" }, ico(icons.spotify), "Megnyitás") : null,
          iconBtn(icons.trash, "Lista törlése innen (a Spotify-on nem törlődik)", () => deletePlaylist(p), true))),
      p.result_note ? h("div", { class: "pl-note" + (p.status === "error" ? " err" : "") }, p.result_note) : null,
      items.length ? h("details", {},
        h("summary", {}, "Zenék"),
        h("ol", {}, items.map((i) => h("li", { class: i.found === false ? "missing" : "" }, i.artist + " – " + i.title)))) : null);
  }

  async function deletePlaylist(p) {
    const msg = p.status === "done"
      ? "Törlöd innen a(z) „" + p.name + "” listát? A Spotify-on megmarad, csak ebből a nyilvántartásból tűnik el."
      : "Törlöd a(z) „" + p.name + "” listát? Így a Pulse sem fogja létrehozni.";
    if (!confirm(msg)) return;
    try {
      await call("admin_delete_playlist", { p_id: p.id });
      toast("Lista törölve.");
      await reload(["playlists", "songs"]);
    } catch (ex) { toast(ex.message, "error"); }
  }

  // ------------------------------------------------------------------ Párbeszédablak
  const dlg = $("#song-dialog");
  function openDialog(mode, song, verdict) {
    state.dialog = { mode, song };
    $("#sd-heading").textContent = mode === "add" ? "Zene felvétele" : "Zene szerkesztése";
    $("#sd-artist").value = song ? song.artist : "";
    $("#sd-title").value = song ? song.title : "";
    $("#sd-note").value = song && song.note ? song.note : "";
    $("#sd-verdict-wrap").classList.toggle("hidden", mode !== "add");
    document.querySelector('input[name="sd-verdict"][value="' + (verdict || "good") + '"]').checked = true;
    $("#sd-error").textContent = "";
    $("#sd-save").disabled = false;
    dlg.showModal();
    $("#sd-artist").focus();
  }
  $("#sd-cancel").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  $("#song-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const artist = $("#sd-artist").value.trim();
    const title = $("#sd-title").value.trim();
    const note = $("#sd-note").value.trim();
    if (!artist || !title) { $("#sd-error").textContent = "Az előadó és a cím is kell."; return; }
    const d = state.dialog;
    $("#sd-save").disabled = true;
    try {
      if (d.mode === "add") {
        const verdict = document.querySelector('input[name="sd-verdict"]:checked').value;
        await call("admin_decide", { p_norm_key: null, p_verdict: verdict, p_artist: artist, p_title: title, p_note: note || null });
        toast("Felvéve: " + artist + " – " + title + " (" + (verdict === "good" ? "jó" : "nem jó") + ")", verdict === "good" ? "success" : undefined);
        dlg.close();
        await reload(["songs", "pending"]);
      } else {
        await call("admin_update_song", { p_song_id: d.song.id, p_artist: artist, p_title: title, p_note: note || null });
        toast("Mentve: " + artist + " – " + title, "success");
        dlg.close();
        await reload(["songs", "pending"]);
      }
    } catch (ex) {
      $("#sd-error").textContent = ex.message;
      $("#sd-save").disabled = false;
    }
  });
})();
