// Pulse ENGINE · Zenekérés — a nyilvános zenekérő oldal
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);

  const station = String(Z.cfg.STATION_NAME || "").trim();
  if (station) {
    $("#station").textContent = station;
    document.title = "Zenekérés · " + station;
  }

  const problem = Z.setupProblem();
  const form = $("#req-form");
  const btn = $("#submit-btn");
  const err = $("#form-error");

  if (problem) {
    const w = $("#setup-warning");
    w.textContent = problem;
    w.classList.remove("hidden");
    btn.disabled = true;
  }

  // Véletlen böngésző-azonosító: ezzel ismeri fel a szerver, ha valaki
  // ugyanazt a számot többször küldi el. Személyes adatot nem tartalmaz.
  function clientId() {
    try {
      let id = localStorage.getItem("zk_client");
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) ||
             Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
        localStorage.setItem("zk_client", id);
      }
      return id;
    } catch (e) {
      return null;
    }
  }

  const MESSAGES = {
    new: {
      icon: Z.icons.check,
      title: "Megkaptuk!",
      text: "A stúdió meghallgatja a kérésed, és ha belefér a suli műsorába, felkerül a lejátszási listára.",
    },
    good: {
      icon: Z.icons.note,
      title: "Ez már bent van!",
      text: "Ez a szám már rajta van a jóváhagyott zenéink között. A kérésedet is beszámoltuk – minél többen kérik, annál hamarabb szól.",
    },
    bad: {
      icon: Z.icons.cross,
      title: "Ez most nem fér bele",
      text: "Ezt a számot korábban már meghallgattuk, és sajnos nem illik az iskolai műsorba. Próbálkozz egy másikkal!",
    },
    duplicate: {
      icon: Z.icons.clock,
      title: "Ezt már kérted",
      text: "Nemrég már elküldted ezt a számot, számon tartjuk. Addig kérhetsz egy másikat is!",
    },
  };

  function showResult(status, artist, title) {
    const m = MESSAGES[status] || MESSAGES.new;
    const view = $("#result-view");
    view.className = "result " + (MESSAGES[status] ? status : "new");
    $("#result-icon").innerHTML = m.icon; // beégetett ikon, nem felhasználói adat
    $("#result-title").textContent = m.title;
    $("#result-song").textContent = artist + " – " + title;
    $("#result-text").textContent = m.text;
    $("#form-view").classList.add("hidden");
    view.classList.remove("hidden");
    $("#again-btn").focus();
  }

  $("#again-btn").addEventListener("click", () => {
    form.reset();
    err.textContent = "";
    $("#result-view").classList.add("hidden");
    $("#form-view").classList.remove("hidden");
    $("#artist").focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (problem) return;
    err.textContent = "";

    const artist = $("#artist").value.trim();
    const title = $("#title").value.trim();
    const requester = $("#requester").value.trim();
    if (!artist) { err.textContent = "Add meg az előadót."; $("#artist").focus(); return; }
    if (!title) { err.textContent = "Add meg a szám címét."; $("#title").focus(); return; }

    btn.disabled = true;
    btn.replaceChildren(Z.h("span", { class: "spinner" }), "Küldés…");
    try {
      const res = await Z.rpc("submit_request", {
        p_artist: artist,
        p_title: title,
        p_requester: requester || null,
        p_client: clientId(),
        p_website: $("#website").value || null,
      });
      showResult(res && res.status, artist, title);
    } catch (ex) {
      err.textContent = ex.message || "Valami hiba történt, próbáld újra.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Kérés elküldése";
    }
  });
})();
