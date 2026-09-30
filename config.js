// =====================================================================
//  Pulse ENGINE · Zenekérés — beállítások
//
//  Ezt az egy fájlt kell kitölteni, mielőtt a mappát feltöltöd a Netlify-ra.
//  Az adatok helye: Supabase → Project Settings → API (vagy "API Keys").
// =====================================================================

window.ZENE_CONFIG = {
  // Project URL, pl. "https://abcdefghijklmnop.supabase.co"
  SUPABASE_URL: "",

  // A NYILVÁNOS kulcs: "Publishable key" (sb_publishable_...)
  // vagy régebbi projekteknél az "anon public" kulcs (eyJ... kezdetű).
  // SOHA ne a secret / service_role kulcsot írd ide: az a Pulse szoftverbe való!
  SUPABASE_KEY: "",

  // A rádió neve – ez jelenik meg a zenekérő oldal tetején.
  STATION_NAME: "Mathiász FM",
};
