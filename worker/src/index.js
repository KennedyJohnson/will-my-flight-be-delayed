// GET /?flight=AA2472&date=2026-09-30 -> {"legs":[{o,d,dep,arr,el,ac,status}]}
// GET /?callsign=AAL2472 -> {"found":true,lat,lon,track,alt_ft,speed_kt,callsign,type,updated} (live position, free ADS-B feeds)
// Looks up the flight's scheduled route on that local departure date from AeroDataBox (free RapidAPI
// plan, ~600 units/month), so the site isn't stuck with a months-old route when airlines reuse numbers.
// Responses are cached at the edge so repeat lookups don't spend quota. The key never reaches the browser.
const ALLOWED_ORIGINS = [/^https:\/\/kennedyjohnson\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const API = "https://aerodatabox.p.rapidapi.com/flights/number";

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") ?? "";
    const cors = ALLOWED_ORIGINS.some((re) => re.test(origin)) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
    if (request.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    if (request.method !== "GET") return json({ error: "method" }, 405, cors);

    const url = new URL(request.url);
    if (url.searchParams.has("callsign")) return position(url.searchParams.get("callsign"), cors);
    const flight = (url.searchParams.get("flight") ?? "").toUpperCase().replace(/\s+/g, "");
    const date = url.searchParams.get("date") ?? "";
    if (!/^[A-Z0-9]{2}\d{1,4}$/.test(flight) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "bad request" }, 400, cors);
    const days = (Date.parse(date) - Date.now()) / 864e5;
    if (!(days > -7 && days < 330)) return json({ legs: [] }, 200, cors, 86400);
    if (!env.RAPIDAPI_KEY) return json({ error: "not configured" }, 503, cors);

    // Cache on a canonical URL so AA2472 / aa 2472 share an entry.
    const cache = caches.default;
    const key = new Request(`https://flight-lookup.cache/${flight}/${date}`);
    const hit = await cache.match(key);
    if (hit) return withHeaders(hit, cors);

    const res = await fetch(`${API}/${flight}/${date}?dateLocalRole=Departure&withAircraftImage=false&withLocation=false`, {
      headers: { "X-RapidAPI-Key": env.RAPIDAPI_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" },
    });
    let body, ttl;
    if (res.status === 204 || res.status === 404) {
      body = { legs: [] }; ttl = 6 * 3600;
    } else if (res.ok) {
      const items = await res.json().catch(() => []);
      body = { legs: (Array.isArray(items) ? items : []).map(toLeg).filter(Boolean) };
      ttl = days < 1 ? 3600 : 12 * 3600; // near-term schedules still shift; later ones rarely do
    } else {
      // quota exhausted (429) or upstream trouble: tell the site to fall back, cache briefly
      return json({ error: `upstream ${res.status}` }, 502, cors, 300);
    }
    const out = json(body, 200, {}, ttl);
    ctx.waitUntil(cache.put(key, out.clone()));
    return withHeaders(out, cors);
  },
};

function toLeg(f) {
  const dep = f.departure ?? {}, arr = f.arrival ?? {};
  const o = dep.airport?.iata, d = arr.airport?.iata;
  const depLocal = dep.scheduledTime?.local ?? dep.scheduledTimeLocal;
  const arrLocal = arr.scheduledTime?.local ?? arr.scheduledTimeLocal;
  if (!o || !d || !depLocal) return null;
  const depUtc = Date.parse(dep.scheduledTime?.utc ?? dep.scheduledTimeUtc ?? "");
  const arrUtc = Date.parse(arr.scheduledTime?.utc ?? arr.scheduledTimeUtc ?? "");
  return {
    o, d,
    dep: hhmm(depLocal), arr: arrLocal ? hhmm(arrLocal) : null,
    el: Number.isFinite(depUtc) && Number.isFinite(arrUtc) ? Math.round((arrUtc - depUtc) / 60000) : null,
    ac: f.aircraft?.model ?? null,
    status: f.status ?? null,
  };
}

// "2026-09-30 16:00-05:00" -> 1600 (local wall-clock time, like the BTS schedules)
function hhmm(s) {
  const m = /[ T](\d{2}):(\d{2})/.exec(s);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

function json(body, status, headers = {}, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(maxAge ? { "Cache-Control": `public, max-age=${maxAge}` } : {}), ...headers },
  });
}

function withHeaders(res, extra) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
  return r;
}

// ---------- Live aircraft position (adsb.lol, then adsb.fi: free community ADS-B feeds, no key) ----------
const FEEDS = [(cs) => `https://api.adsb.lol/v2/callsign/${cs}`, (cs) => `https://opendata.adsb.fi/api/v2/callsign/${cs}`];
const FEED_UA = "flight-live/1.0 (+https://kennedyjohnson.github.io/will-my-flight-be-delayed/)";

async function position(raw, cors) {
  const callsign = String(raw ?? "").toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(callsign)) return json({ found: false, error: "bad callsign" }, 400, cors);
  for (const feed of FEEDS) {
    try {
      const r = await fetch(feed(callsign), { headers: { "User-Agent": FEED_UA }, cf: { cacheTtl: 15, cacheEverything: true } });
      if (!r.ok) continue;
      const j = await r.json();
      const a = (j.ac ?? j.aircraft ?? []).find((x) => typeof x.lat === "number" && typeof x.lon === "number");
      if (!a) return json({ found: false }, 200, cors, 15);
      return json({
        found: true, lat: a.lat, lon: a.lon,
        track: typeof a.track === "number" ? a.track : null,
        alt_ft: typeof a.alt_baro === "number" ? a.alt_baro : a.alt_baro === "ground" ? 0 : null,
        speed_kt: typeof a.gs === "number" ? Math.round(a.gs) : null,
        callsign: String(a.flight ?? callsign).trim(), type: a.t ?? null,
        updated: Math.max(0, Math.round(a.seen_pos ?? a.seen ?? 0)),
      }, 200, cors, 15);
    } catch { /* try the next feed */ }
  }
  return json({ found: false }, 200, cors, 15);
}
