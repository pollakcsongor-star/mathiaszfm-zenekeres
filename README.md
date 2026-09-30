# Pulse ENGINE · Zenekérés (weboldal)

A diákok itt kérnek zenét a Google-űrlap helyett, a stúdió az admin oldalon
bírálja el őket. A rendszer **megjegyzi a döntést**: ha valaki újra beküldi
ugyanazt (akár kisbetűvel, ékezet nélkül vagy „(Official Video)”-val), már nem
kell újra elbírálni. A jó zenékből a stúdió lejátszási listát állít össze, a
Pulse szoftver pedig egy gombnyomással létrehozza a Spotify-on.

```
diák ──► zenekérő oldal ──► Supabase ◄── admin oldal (bírálás, lista)
                                 ▲
                                 └──── Pulse: Zene Kérések menü ──► Spotify
```

## Mi hol van

| Fájl | Mire való |
|---|---|
| `index.html` | A zenekérő oldal (ezt kapják meg a diákok) |
| `admin.html` | Stúdió: bírálás, jó és elutasított zenék, lejátszási listák |
| `config.js` | **Az egyetlen fájl, amit ki kell tölteni** (Supabase cím + nyilvános kulcs) |
| `assets/` | Stílus, logó, JavaScript |
| `supabase/schema.sql` | Az adatbázis: egyszer kell lefuttatni a Supabase-ben |
| `_headers`, `_redirects`, `404.html` | Netlify-beállítások (a README és az SQL nem lesz elérhető a weben) |

## Telepítés (egyszer kell)

### 1. Supabase projekt
1. [supabase.com](https://supabase.com) → **New project**. Régiónak a Frankfurtot (Central EU) érdemes választani.
2. **SQL Editor → New query** → másold be a `supabase/schema.sql` teljes tartalmát → **Run**.
   Ha a böngésző fordítja az oldalt, kapcsold ki rá a fordítást, mert az SQL-t is lefordítja és elrontja.
3. **Authentication → Users → Add user → Create new user**: add meg a saját e-mail-címed és egy jelszót,
   és pipáld be az **Auto Confirm User**-t. Ezzel lépsz majd be az admin oldalra.
4. Tedd magad adminná (SQL Editor, a saját e-mail-címeddel):
   ```sql
   insert into public.admins (email) values ('a-te-emailed@pelda.hu');
   ```
   Több admin is lehet, mindegyikhez kell egy felhasználó (3. lépés) és egy ilyen sor.
5. Ajánlott: **Authentication → Sign In / Providers** alatt kapcsold ki az **Allow new users to sign up** opciót.
   (Enélkül sem tud senki belenézni: aki nincs az `admins` táblában, az nem lát semmit.)

### 2. `config.js` kitöltése
**Project Settings → API Keys** (régebben: API):
- `SUPABASE_URL`: a Project URL, pl. `https://abcdefgh.supabase.co`
- `SUPABASE_KEY`: a **Publishable key** (`sb_publishable_...`), régebbi projekteknél az **anon public** kulcs.

A **secret / service_role** kulcs SOHA ne kerüljön ide – az a Pulse-ba való (4. lépés).
Ha véletlenül ide kerülne, az oldal nem indul el, és szól.

### 3. Feltöltés a Netlify-ra
1. [app.netlify.com](https://app.netlify.com) → **Add new site → Deploy manually**.
2. Húzd rá az egész **`zene-web`** mappát.
3. **Site configuration → Change site name**: adj neki beszédes nevet (pl. `mathiaszfm-zenekeres`).

Címek:
- Zenekérő oldal: `https://<név>.netlify.app` – ezt kapják meg a diákok (QR-kódnak is jó)
- Admin: `https://<név>.netlify.app/admin`

Ha később módosul valami a mappában: Netlify → a site → **Deploys** → húzd rá újra a mappát.

### 4. Pulse szoftver
**Zene Kérések** menü → **⚙** gomb:
- Supabase cím: ugyanaz, mint a `config.js`-ben
- Secret kulcs: **Project Settings → API Keys → Secret keys** (`sb_secret_...`), régebbi projekteknél a **service_role** kulcs
- Weboldal címe: a Netlify-cím (a „Zenekérő oldal” és „Admin” gombokhoz)

→ **Mentés és próba**. Ha rendben van, megjelenik, hány kérés vár bírálásra.

## Használat

1. **Bírálás** fül: minden új kérésnél **Jó** vagy **Nem jó**. Előtte kijavíthatod az előadót és a címet
   (pl. „desz” → „Desh”); a javított és a diák által beírt írásmód is megjegyződik.
   - Ha ugyanazt többen kérték, egy sorban látszik, a kérések számával.
   - Elgépelésnél (pl. „trainign season”) megjelenik a hasonló, már elbírált zene: az **Ugyanaz** gombbal
     átveszi annak a döntését, és az elgépelést is megjegyzi.
   - Értelmetlen, szemét kérést a kuka gombbal törölhetsz döntés nélkül.
2. **Jó zenék** fül: pipáld ki, ami a listába kell (rendezhető a legtöbbet kértek szerint, és szűrhető arra,
   ami még nem volt listán), alul add meg a lista nevét → **Lista összeállítása**.
3. **Pulse → Zene Kérések → Listák lekérése → Létrehozás a Spotify-on.** A Pulse megkeresi a zenéket, létrehozza
   a (privát) listát a Spotify-fiókodban, és visszaírja a weboldalnak, hogy kész, mit nem talált meg.
   A lista ezután a Pulse Műsortervében is kiválasztható, mint bármelyik Spotify-lista.
4. Ha meggondolod magad: az **Elutasítva** / **Jó zenék** fülön egy zene átrakható a másik oldalra,
   vagy az **Újrabírálás** gombbal visszakerül a Bírálás fülre.

## Jó tudni

- **A diákok válaszként azonnal látják**, ha a kért szám már jóváhagyott, vagy korábban elutasítottuk.
- **Spam elleni fék:** ugyanaz a böngésző 12 órán belül ugyanazt a számot nem kérheti kétszer, és 10 percen
  belül legfeljebb 6 kérést küldhet. Egy IP-címről (a suli wifije közös!) 10 percenként 150 kérés fér át.
  Van egy robotcsapda is.
- **Adatvédelem:** a név/osztály mező nem kötelező. IP-címet nem tárolunk, csak egy abból képzett,
  visszafejthetetlen lenyomatot a spam-fékhez.
- **Az ingyenes Supabase projekt egy hét tétlenség után „elalszik”** (pl. nyári szünetben).
  Ilyenkor a Supabase-ben a projektnél a **Restore** gombbal fel kell ébreszteni; az adatok megmaradnak.
- A régi Google-űrlapos megoldás (Google Sheets + Gemini-ellenőrzés) a Pulse-ból ki lett kötve.
