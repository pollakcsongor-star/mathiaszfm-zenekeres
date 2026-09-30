-- =====================================================================
--  Pulse ENGINE · Zenekérés — Supabase adatbázis
--
--  Futtatás:  Supabase → SQL Editor → New query → az EGÉSZET bemásolod → Run
--  Többször is lefuttatható: adatot nem töröl, csak létrehozza / frissíti
--  a táblákat és a függvényeket.
--
--  Utána még egy sor kell (a README 3. lépése), amivel magadat adminná teszed:
--    insert into public.admins (email) values ('a-te-emailed@pelda.hu');
--
--  Felépítés röviden
--    requests        – minden beérkező kérés, úgy, ahogy a diák beírta
--    songs           – az ELBÍRÁLT zenék (jó / nem jó): ez a "memória"
--    song_keys       – egy zenéhez több írásmód is tartozhat (elgépelés,
--                      kisbetű, ékezet), mind ugyanarra a döntésre mutat
--    playlists       – a weboldalon összeállított lejátszási listák;
--                      a Pulse szoftver ezeket hozza létre a Spotify-on
--    playlist_items  – a listák zenéi, sorrendben
--
--  Biztonság: a táblákhoz a weboldal kulcsa (anon / publishable key) semmilyen
--  közvetlen hozzáférést nem kap. Minden a lenti függvényeken megy át:
--    · submit_request   – bárki (a zenekérő oldal)
--    · admin_*          – csak az admins táblában szereplő, bejelentkezett felhasználó
--    · pulse_*          – csak a secret (service_role) kulccsal, azaz a Pulse szoftver
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Táblák
-- ---------------------------------------------------------------------

create table if not exists public.admins (
  email      text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.songs (
  id          bigint generated always as identity primary key,
  artist      text not null,
  title       text not null,
  verdict     text not null check (verdict in ('good', 'bad')),
  note        text,
  spotify_uri text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz not null default now()
);

create table if not exists public.song_keys (
  norm_key text primary key,
  song_id  bigint not null references public.songs (id) on delete cascade
);
create index if not exists song_keys_song_idx on public.song_keys (song_id);

create table if not exists public.requests (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  artist       text not null,
  title        text not null,
  requester    text,
  norm_key     text not null default '',
  -- NULL = még nincs elbírálva. Ha a zenét már egyszer elbíráltuk, a kérés
  -- beérkezéskor azonnal megkapja (auto_decided = true), nem kell újra nézni.
  song_id      bigint references public.songs (id) on delete set null,
  auto_decided boolean not null default false,
  client_hash  text,
  ip_hash      text
);
create index if not exists requests_pending_idx on public.requests (norm_key) where song_id is null;
create index if not exists requests_song_idx    on public.requests (song_id);
create index if not exists requests_created_idx on public.requests (created_at);
create index if not exists requests_client_idx  on public.requests (client_hash, created_at);
create index if not exists requests_ip_idx      on public.requests (ip_hash, created_at);

create table if not exists public.playlists (
  id           bigint generated always as identity primary key,
  name         text not null,
  status       text not null default 'pending' check (status in ('pending', 'done', 'error')),
  created_at   timestamptz not null default now(),
  created_by   text,
  processed_at timestamptz,
  spotify_url  text,
  result_note  text
);

create table if not exists public.playlist_items (
  playlist_id bigint not null references public.playlists (id) on delete cascade,
  song_id     bigint not null references public.songs (id) on delete cascade,
  position    int not null,
  found       boolean,          -- megtalálta-e a Pulse a Spotify-on
  primary key (playlist_id, song_id)
);
create index if not exists playlist_items_song_idx on public.playlist_items (song_id);


-- ---------------------------------------------------------------------
-- 2. Hozzáférés: közvetlenül senki, csak a függvényeken keresztül
-- ---------------------------------------------------------------------

alter table public.admins         enable row level security;
alter table public.songs          enable row level security;
alter table public.song_keys      enable row level security;
alter table public.requests       enable row level security;
alter table public.playlists      enable row level security;
alter table public.playlist_items enable row level security;

revoke all on public.admins, public.songs, public.song_keys, public.requests,
              public.playlists, public.playlist_items
  from anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. Írásmód-független kulcs
--
-- "Dua Lipa – Training Season", "dua lipa - training season (Official Video)"
-- és "DUA LIPA feat. Valaki - Training Season" ugyanazt a kulcsot kapja:
-- kisbetű, ékezet nélkül, zárójeles rész és "feat. ..." nélkül, csak betű
-- és szám. Az elgépeléseket (trainign) ez nem fogja meg: azokra az admin
-- oldal hoz hasonló, már elbírált zenét, és egy kattintás összekötni őket.
-- ---------------------------------------------------------------------

create or replace function public.zk_norm(p text)
returns text
language plpgsql immutable parallel safe
set search_path = ''
as $$
declare
  s text := lower(translate(coalesce(p, ''),
    'áàâäãåāăąčćçĉďđéèêëěēėęíìîïīįľĺłňñńóòôöõőøōřŕšśşťţúùûüűůūųýÿžźżÁÀÂÄÃÅĀĂĄČĆÇĈĎĐÉÈÊËĚĒĖĘÍÌÎÏĪĮĽĹŁŇÑŃÓÒÔÖÕŐØŌŘŔŠŚŞŤŢÚÙÛÜŰŮŪŲÝŸŽŹŻ',
    'aaaaaaaaaccccddeeeeeeeeiiiiiilllnnnoooooooorrsssttuuuuuuuuyyzzzaaaaaaaaaccccddeeeeeeeeiiiiiilllnnnoooooooorrsssttuuuuuuuuyyzzz'));
  t text;
begin
  s := replace(s, '&', ' and ');
  t := regexp_replace(s, '\([^)]*\)|\[[^]]*\]', ' ', 'g');
  t := regexp_replace(t, '\s(feat|ft|featuring)\.?\s.*$', ' ');
  t := btrim(regexp_replace(t, '[^a-z0-9]+', ' ', 'g'));
  -- Ha a zárójel levágása után semmi nem maradt (pl. a cím maga "(Intro)"),
  -- akkor inkább a zárójeles szöveget tartjuk meg.
  if t = '' then
    t := btrim(regexp_replace(s, '[^a-z0-9]+', ' ', 'g'));
  end if;
  return t;
end
$$;

create or replace function public.zk_key(p_artist text, p_title text)
returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select public.zk_norm(p_artist) || ' | ' || public.zk_norm(p_title)
$$;

-- Beérkezéskor a kérés megkapja a kulcsát, és ha a zenét már elbíráltuk,
-- rögtön a döntést is.
create or replace function public.zk_requests_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.norm_key := public.zk_key(new.artist, new.title);
  new.song_id := (select k.song_id from public.song_keys k where k.norm_key = new.norm_key);
  new.auto_decided := new.song_id is not null;
  return new;
end
$$;

drop trigger if exists zk_requests_before_insert on public.requests;
create trigger zk_requests_before_insert
  before insert on public.requests
  for each row execute function public.zk_requests_before_insert();


-- ---------------------------------------------------------------------
-- 4. Admin-ellenőrzés
-- ---------------------------------------------------------------------

create or replace function public.zk_is_admin()
returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$$;

create or replace function public.zk_require_admin()
returns void
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  if not public.zk_is_admin() then
    raise exception 'Ehhez admin jogosultság kell.' using errcode = '42501';
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 5. Zenekérő oldal (bárki hívhatja)
--
-- Válasz: {"status": "new" | "good" | "bad" | "duplicate"}
--   new       – új zene, bírálásra vár
--   good      – ezt már elbíráltuk, és jó
--   bad       – ezt már elbíráltuk, és nem fér bele a műsorba
--   duplicate – ugyanez a böngésző nemrég már kérte
-- ---------------------------------------------------------------------

create or replace function public.submit_request(
  p_artist    text,
  p_title     text,
  p_requester text default null,
  p_client    text default null,
  p_website   text default null
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_artist    text := left(btrim(regexp_replace(coalesce(p_artist, ''), '\s+', ' ', 'g')), 120);
  v_title     text := left(btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g')), 160);
  v_requester text := nullif(left(btrim(regexp_replace(coalesce(p_requester, ''), '\s+', ' ', 'g')), 80), '');
  v_key       text;
  v_headers   json;
  v_ip        text;
  v_ip_hash   text;
  v_client    text;
  v_song      bigint;
  v_verdict   text;
begin
  -- Robotcsapda: ezt a mezőt ember nem látja, így nem is tölti ki.
  -- A robot "sikert" kap, hogy ne próbálkozzon tovább.
  if coalesce(p_website, '') <> '' then
    return json_build_object('status', 'new');
  end if;

  if public.zk_norm(v_artist) = '' or public.zk_norm(v_title) = '' then
    raise exception 'Add meg az előadót és a szám címét is.' using errcode = '22023';
  end if;
  v_key := public.zk_key(v_artist, v_title);

  -- Összesített fék: egy elszabadult robot se tudja elárasztani az adatbázist.
  if (select count(*) from public.requests r
      where r.created_at > now() - interval '10 minutes') >= 400 then
    raise exception 'Most nagyon sok kérés érkezik. Próbáld újra pár perc múlva!' using errcode = '22023';
  end if;

  -- IP szerinti fék. Bőkezű, mert a suli wifijén mindenki ugyanarról az
  -- IP-ről jön; ez csak a nyilvánvaló gépi elárasztást fogja meg.
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  v_ip := nullif(btrim(coalesce(
            v_headers ->> 'cf-connecting-ip',
            v_headers ->> 'x-real-ip',
            split_part(v_headers ->> 'x-forwarded-for', ',', 1))), '');
  if v_ip is not null then
    v_ip_hash := md5('pulse-zk-ip:' || v_ip);
    if (select count(*) from public.requests r
        where r.ip_hash = v_ip_hash and r.created_at > now() - interval '10 minutes') >= 150 then
      raise exception 'Túl sok kérés jött erről a hálózatról. Próbáld újra pár perc múlva!' using errcode = '22023';
    end if;
  end if;

  -- Böngészőnkénti fék (a zenekérő oldal egy véletlen azonosítót küld).
  v_client := nullif(left(btrim(coalesce(p_client, '')), 64), '');
  if v_client is not null then
    v_client := md5('pulse-zk-client:' || v_client);
    if exists (select 1 from public.requests r
               where r.client_hash = v_client and r.norm_key = v_key
                 and r.created_at > now() - interval '12 hours') then
      return json_build_object('status', 'duplicate');
    end if;
    if (select count(*) from public.requests r
        where r.client_hash = v_client and r.created_at > now() - interval '10 minutes') >= 6 then
      raise exception 'Egyszerre ennyi elég! Pár perc múlva kérhetsz újra.' using errcode = '22023';
    end if;
  end if;

  insert into public.requests (artist, title, requester, client_hash, ip_hash)
  values (v_artist, v_title, v_requester, v_client, v_ip_hash)
  returning song_id into v_song;

  if v_song is null then
    return json_build_object('status', 'new');
  end if;
  select s.verdict into v_verdict from public.songs s where s.id = v_song;
  return json_build_object('status', v_verdict);
end
$$;


-- ---------------------------------------------------------------------
-- 6. Admin oldal
-- ---------------------------------------------------------------------

-- Ki vagyok, és admin vagyok-e? (a belépés után ezzel dönt az oldal)
create or replace function public.admin_whoami()
returns json
language sql stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'email', auth.jwt() ->> 'email',
    'is_admin', public.zk_is_admin()
  )
$$;

-- Bírálásra váró kérések, írásmód szerint csoportosítva
-- (ha öten kérték ugyanazt, az egy sor, "×5"-tel).
create or replace function public.admin_pending()
returns json
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  perform public.zk_require_admin();
  return (
    select coalesce(json_agg(g order by g.first_at), '[]'::json)
    from (
      select r.norm_key,
             (array_agg(r.artist order by r.created_at desc))[1] as artist,
             (array_agg(r.title  order by r.created_at desc))[1] as title,
             count(*)::int                                       as count,
             min(r.created_at)                                   as first_at,
             max(r.created_at)                                   as last_at,
             coalesce(array_agg(distinct r.requester)
                        filter (where r.requester is not null), '{}') as requesters
      from public.requests r
      where r.song_id is null
      group by r.norm_key
    ) g
  );
end
$$;

-- Döntés egy kérés-csoportról (vagy új zene kézi felvétele: p_norm_key = null).
-- A javított írásmód (p_artist, p_title) és a diák eredeti írásmódja is
-- megjegyződik, így legközelebb egyiket sem kell újra bírálni.
create or replace function public.admin_decide(
  p_norm_key text,
  p_verdict  text,
  p_artist   text,
  p_title    text,
  p_note     text default null
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_artist  text := left(btrim(regexp_replace(coalesce(p_artist, ''), '\s+', ' ', 'g')), 120);
  v_title   text := left(btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g')), 160);
  v_note    text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
  v_orig    text := nullif(p_norm_key, '');
  v_canon   text;
  v_song    bigint;
  v_updated int;
begin
  perform public.zk_require_admin();
  if p_verdict is null or p_verdict not in ('good', 'bad') then
    raise exception 'Ismeretlen döntés: %', p_verdict using errcode = '22023';
  end if;
  if public.zk_norm(v_artist) = '' or public.zk_norm(v_title) = '' then
    raise exception 'Az előadó és a cím nem lehet üres.' using errcode = '22023';
  end if;
  v_canon := public.zk_key(v_artist, v_title);

  select k.song_id into v_song from public.song_keys k where k.norm_key = v_canon;
  if v_song is null and v_orig is not null then
    select k.song_id into v_song from public.song_keys k where k.norm_key = v_orig;
  end if;

  if v_song is null then
    insert into public.songs (artist, title, verdict, note)
    values (v_artist, v_title, p_verdict, v_note)
    returning id into v_song;
  else
    -- Már ismert zene: a döntés frissül, az írásmódja marad
    -- (átnevezni a "Jó zenék" listán lehet).
    update public.songs s
       set verdict = p_verdict,
           note = coalesce(v_note, s.note),
           decided_at = now()
     where s.id = v_song;
  end if;

  insert into public.song_keys (norm_key, song_id) values (v_canon, v_song)
    on conflict (norm_key) do nothing;
  if v_orig is not null then
    insert into public.song_keys (norm_key, song_id) values (v_orig, v_song)
      on conflict (norm_key) do nothing;
  end if;

  update public.requests r
     set song_id = v_song
   where r.song_id is null
     and r.norm_key in (v_canon, coalesce(v_orig, v_canon));
  get diagnostics v_updated = row_count;

  return json_build_object('song_id', v_song, 'verdict', p_verdict, 'requests', v_updated);
end
$$;

-- "Ez ugyanaz, mint ..." – egy kérés-csoport hozzákötése egy már elbírált
-- zenéhez (pl. elgépelés). A zene döntése öröklődik.
create or replace function public.admin_link(p_norm_key text, p_song_id bigint)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verdict text;
  v_updated int;
begin
  perform public.zk_require_admin();
  select s.verdict into v_verdict from public.songs s where s.id = p_song_id;
  if v_verdict is null then
    raise exception 'Ez a zene már nincs meg.' using errcode = '22023';
  end if;
  if coalesce(p_norm_key, '') = '' then
    raise exception 'Hiányzik a kérés azonosítója.' using errcode = '22023';
  end if;

  insert into public.song_keys (norm_key, song_id) values (p_norm_key, p_song_id)
    on conflict (norm_key) do update set song_id = excluded.song_id;

  update public.requests r
     set song_id = p_song_id
   where r.song_id is null and r.norm_key = p_norm_key;
  get diagnostics v_updated = row_count;

  return json_build_object('song_id', p_song_id, 'verdict', v_verdict, 'requests', v_updated);
end
$$;

-- Szemét (pl. "asdasd") törlése a bírálandók közül, döntés nélkül.
create or replace function public.admin_delete_pending(p_norm_key text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  perform public.zk_require_admin();
  delete from public.requests r where r.song_id is null and r.norm_key = p_norm_key;
  get diagnostics v_deleted = row_count;
  return json_build_object('deleted', v_deleted);
end
$$;

-- Az összes elbírált zene (jó és nem jó), kérésszámmal.
create or replace function public.admin_songs()
returns json
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  perform public.zk_require_admin();
  return (
    select coalesce(json_agg(x order by x.decided_at desc), '[]'::json)
    from (
      select s.id, s.artist, s.title, s.verdict, s.note, s.spotify_uri,
             s.created_at, s.decided_at,
             coalesce(rc.cnt, 0)          as request_count,
             rc.last_at                   as last_requested,
             coalesce(pc.cnt, 0)          as playlist_count,
             coalesce(kk.keys, '[]'::json) as keys
      from public.songs s
      left join (select r.song_id, count(*)::int as cnt, max(r.created_at) as last_at
                   from public.requests r where r.song_id is not null
                  group by r.song_id) rc on rc.song_id = s.id
      left join (select pi.song_id, count(*)::int as cnt
                   from public.playlist_items pi group by pi.song_id) pc on pc.song_id = s.id
      left join (select k.song_id, json_agg(k.norm_key) as keys
                   from public.song_keys k group by k.song_id) kk on kk.song_id = s.id
    ) x
  );
end
$$;

-- Döntés megváltoztatása egy már elbírált zenén (Mégis jó / Mégsem jó).
create or replace function public.admin_set_verdict(p_song_id bigint, p_verdict text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.zk_require_admin();
  if p_verdict is null or p_verdict not in ('good', 'bad') then
    raise exception 'Ismeretlen döntés: %', p_verdict using errcode = '22023';
  end if;
  update public.songs s set verdict = p_verdict, decided_at = now() where s.id = p_song_id;
  if not found then
    raise exception 'Ez a zene már nincs meg.' using errcode = '22023';
  end if;
  return json_build_object('song_id', p_song_id, 'verdict', p_verdict);
end
$$;

-- Zene átnevezése / megjegyzés. A régi írásmódok továbbra is ide mutatnak.
create or replace function public.admin_update_song(
  p_song_id bigint,
  p_artist  text,
  p_title   text,
  p_note    text default null
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_artist text := left(btrim(regexp_replace(coalesce(p_artist, ''), '\s+', ' ', 'g')), 120);
  v_title  text := left(btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g')), 160);
  v_canon  text;
  v_other  bigint;
begin
  perform public.zk_require_admin();
  if public.zk_norm(v_artist) = '' or public.zk_norm(v_title) = '' then
    raise exception 'Az előadó és a cím nem lehet üres.' using errcode = '22023';
  end if;
  v_canon := public.zk_key(v_artist, v_title);

  select k.song_id into v_other from public.song_keys k where k.norm_key = v_canon;
  if v_other is not null and v_other <> p_song_id then
    raise exception 'Ilyen néven már van egy elbírált zene.' using errcode = '22023';
  end if;

  update public.songs s
     set artist = v_artist, title = v_title,
         note = nullif(left(btrim(coalesce(p_note, '')), 300), '')
   where s.id = p_song_id;
  if not found then
    raise exception 'Ez a zene már nincs meg.' using errcode = '22023';
  end if;

  insert into public.song_keys (norm_key, song_id) values (v_canon, p_song_id)
    on conflict (norm_key) do nothing;
  -- Ha várt ilyen írásmódú kérés, az is megkapja a döntést.
  update public.requests r set song_id = p_song_id
   where r.song_id is null and r.norm_key = v_canon;

  return json_build_object('song_id', p_song_id);
end
$$;

-- "Újrabírálás": a zene döntése törlődik, a kérései visszakerülnek a
-- bírálandók közé.
create or replace function public.admin_reopen_song(p_song_id bigint)
returns json
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.zk_require_admin();
  delete from public.songs s where s.id = p_song_id;
  return json_build_object('song_id', p_song_id);
end
$$;

-- Lejátszási lista összeállítása a jó zenékből. A Pulse szoftver hozza létre
-- a Spotify-on, amikor ott megnyomod a gombot.
create or replace function public.admin_create_playlist(p_name text, p_song_ids bigint[])
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name  text := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 100);
  v_id    bigint;
  v_count int;
begin
  perform public.zk_require_admin();
  if v_name = '' then
    raise exception 'Adj nevet a lejátszási listának.' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_song_ids), 0) = 0 then
    raise exception 'Válassz ki legalább egy zenét.' using errcode = '22023';
  end if;
  if cardinality(p_song_ids) > 500 then
    raise exception 'Egy listába legfeljebb 500 zene fér.' using errcode = '22023';
  end if;

  insert into public.playlists (name, created_by)
  values (v_name, auth.jwt() ->> 'email')
  returning id into v_id;

  insert into public.playlist_items (playlist_id, song_id, position)
  select v_id, s.id, u.ord::int
    from unnest(p_song_ids) with ordinality as u(song_id, ord)
    join public.songs s on s.id = u.song_id and s.verdict = 'good'
  on conflict do nothing;
  get diagnostics v_count = row_count;

  if v_count = 0 then
    raise exception 'A kiválasztott zenék közül egyik sincs a jók között.' using errcode = '22023';
  end if;

  return json_build_object('id', v_id, 'count', v_count);
end
$$;

create or replace function public.admin_playlists()
returns json
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  perform public.zk_require_admin();
  return (
    select coalesce(json_agg(p order by p.created_at desc), '[]'::json)
    from (
      select pl.id, pl.name, pl.status, pl.created_at, pl.created_by,
             pl.processed_at, pl.spotify_url, pl.result_note,
             (select coalesce(json_agg(json_build_object(
                        'song_id', s.id, 'artist', s.artist, 'title', s.title,
                        'found', pi.found) order by pi.position), '[]'::json)
                from public.playlist_items pi
                join public.songs s on s.id = pi.song_id
               where pi.playlist_id = pl.id) as items
        from public.playlists pl
       order by pl.created_at desc
       limit 100
    ) p
  );
end
$$;

create or replace function public.admin_delete_playlist(p_id bigint)
returns json
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.zk_require_admin();
  delete from public.playlists pl where pl.id = p_id;
  return json_build_object('id', p_id);
end
$$;


-- ---------------------------------------------------------------------
-- 7. Pulse szoftver (csak a secret / service_role kulccsal hívható)
-- ---------------------------------------------------------------------

create or replace function public.pulse_status()
returns json
language sql stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'pending_requests',  (select count(distinct r.norm_key) from public.requests r where r.song_id is null),
    'good_songs',        (select count(*) from public.songs s where s.verdict = 'good'),
    'pending_playlists', (select count(*) from public.playlists pl where pl.status <> 'done')
  )
$$;

-- A még létre nem hozott (vagy hibára futott) listák, zenéikkel együtt.
create or replace function public.pulse_playlists()
returns json
language sql stable
security definer
set search_path = ''
as $$
  select coalesce(json_agg(p order by p.created_at), '[]'::json)
  from (
    select pl.id, pl.name, pl.status, pl.created_at, pl.created_by, pl.result_note,
           (select coalesce(json_agg(json_build_object(
                      'song_id', s.id, 'artist', s.artist, 'title', s.title,
                      'spotify_uri', s.spotify_uri) order by pi.position), '[]'::json)
              from public.playlist_items pi
              join public.songs s on s.id = pi.song_id
             where pi.playlist_id = pl.id) as items
      from public.playlists pl
     where pl.status <> 'done'
  ) p
$$;

-- Visszajelzés a Pulse-tól: kész (vagy hiba), a Spotify-link, és hogy melyik
-- zenét találta meg. A megtalált Spotify-azonosítót a zene megjegyzi, így
-- legközelebb nem kell újra keresni.
--   p_items: [{"song_id": 1, "found": true, "spotify_uri": "spotify:track:..."}]
create or replace function public.pulse_finish_playlist(
  p_id          bigint,
  p_ok          boolean,
  p_spotify_url text default null,
  p_note        text default null,
  p_items       json default '[]'
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.playlists pl
     set status = case when p_ok then 'done' else 'error' end,
         processed_at = now(),
         spotify_url = coalesce(nullif(p_spotify_url, ''), pl.spotify_url),
         result_note = left(p_note, 500)
   where pl.id = p_id;
  if not found then
    raise exception 'Nincs ilyen lejátszási lista: %', p_id using errcode = '22023';
  end if;

  update public.playlist_items pi
     set found = (e ->> 'found')::boolean
    from json_array_elements(coalesce(p_items, '[]'::json)) e
   where pi.playlist_id = p_id
     and pi.song_id = (e ->> 'song_id')::bigint
     and e ->> 'found' is not null;

  update public.songs s
     set spotify_uri = e ->> 'spotify_uri'
    from json_array_elements(coalesce(p_items, '[]'::json)) e
   where s.id = (e ->> 'song_id')::bigint
     and coalesce(e ->> 'spotify_uri', '') <> '';

  return json_build_object('id', p_id, 'status', case when p_ok then 'done' else 'error' end);
end
$$;


-- ---------------------------------------------------------------------
-- 8. Ki mit hívhat
-- (A Supabase alapból mindenkinek engedi az új függvényeket, ezért előbb
--  mindent elveszünk, aztán szerepkörönként visszaadjuk.)
-- ---------------------------------------------------------------------

revoke execute on function
  public.zk_norm(text),
  public.zk_key(text, text),
  public.zk_requests_before_insert(),
  public.zk_is_admin(),
  public.zk_require_admin(),
  public.submit_request(text, text, text, text, text),
  public.admin_whoami(),
  public.admin_pending(),
  public.admin_decide(text, text, text, text, text),
  public.admin_link(text, bigint),
  public.admin_delete_pending(text),
  public.admin_songs(),
  public.admin_set_verdict(bigint, text),
  public.admin_update_song(bigint, text, text, text),
  public.admin_reopen_song(bigint),
  public.admin_create_playlist(text, bigint[]),
  public.admin_playlists(),
  public.admin_delete_playlist(bigint),
  public.pulse_status(),
  public.pulse_playlists(),
  public.pulse_finish_playlist(bigint, boolean, text, text, json)
from public, anon, authenticated;

grant execute on function public.submit_request(text, text, text, text, text)
  to anon, authenticated;

grant execute on function
  public.admin_whoami(),
  public.admin_pending(),
  public.admin_decide(text, text, text, text, text),
  public.admin_link(text, bigint),
  public.admin_delete_pending(text),
  public.admin_songs(),
  public.admin_set_verdict(bigint, text),
  public.admin_update_song(bigint, text, text, text),
  public.admin_reopen_song(bigint),
  public.admin_create_playlist(text, bigint[]),
  public.admin_playlists(),
  public.admin_delete_playlist(bigint)
to authenticated;

grant execute on function
  public.pulse_status(),
  public.pulse_playlists(),
  public.pulse_finish_playlist(bigint, boolean, text, text, json)
to service_role;
