import { DelayModel } from "./model.js";

const WX_VARS = ["temperature_2m", "precipitation", "snowfall", "wind_speed_10m",
  "wind_gusts_10m", "cloud_cover", "cloud_cover_low", "weather_code"];
// Regional carriers that fly under a mainline brand's flight numbers
const PARTNERS = {
  AA: ["MQ", "OH", "YX", "PT", "ZW"], DL: ["9E", "OO", "YX"], UA: ["OO", "YX", "ZW", "G7", "C5"],
  AS: ["QX", "OO"], HA: [], WN: [], B6: [], NK: [], F9: [], G4: [],
};
const NAME_TO_CODE = {
  AMERICAN: "AA", DELTA: "DL", UNITED: "UA", SOUTHWEST: "WN", ALASKA: "AS", JETBLUE: "B6",
  SPIRIT: "NK", FRONTIER: "F9", ALLEGIANT: "G4", HAWAIIAN: "HA", BREEZE: "MX", AVELO: "XP", "SUN COUNTRY": "SY",
};
const EXAMPLES = ["AA 2919", "DL 2223", "UA 1162", "WN 4608", "AS 98", "B6 234"];
const LABELS = {
  month: "Month of year", dow: "Day of week", dep_hour: "Departure hour", arr_hour: "Arrival hour",
  distance: "Distance", crs_elapsed: "Scheduled duration", leg_index: "Aircraft's leg of the day",
  origin_hour_volume: "Departure-hour traffic", dest_hour_volume: "Arrival-hour traffic",
  carrier_rate: "Airline's delay history", origin_rate: "Origin airport's delay history",
  dest_rate: "Destination airport's delay history", route_rate: "Route's delay history",
  carrier_origin_rate: "Airline at this airport", origin_hour_rate: "Delays at this airport & hour",
  flight_rate: "This flight number's history", carrier_dest_rate: "Airline at the destination",
  aircraft_rate: "Aircraft type's delay history", inbound_rate: "Where the plane is coming from",
  turnaround: "Time to turn the plane around", aircraft_age: "Aircraft age", seats: "Aircraft size",
  regional: "Regional airline", days_to_holiday: "Days from a major holiday",
};
const WX_LABELS = {
  temperature_2m: "temperature", precipitation: "precipitation", snowfall: "snowfall",
  wind_speed_10m: "wind", wind_gusts_10m: "wind gusts", cloud_cover: "cloud cover",
  cloud_cover_low: "low clouds", weather_code: "conditions", precipitation_day: "daily precipitation",
  snowfall_day: "daily snowfall",
};
const WMO = {
  0: ["Clear", "☀️"], 1: ["Mostly clear", "🌤️"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"],
  45: ["Fog", "🌫️"], 48: ["Freezing fog", "🌫️"], 51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"],
  55: ["Heavy drizzle", "🌧️"], 56: ["Freezing drizzle", "🌧️"], 57: ["Freezing drizzle", "🌧️"],
  61: ["Light rain", "🌦️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"], 66: ["Freezing rain", "🌧️"],
  67: ["Freezing rain", "🌧️"], 71: ["Light snow", "🌨️"], 73: ["Snow", "🌨️"], 75: ["Heavy snow", "❄️"],
  77: ["Snow grains", "🌨️"], 80: ["Rain showers", "🌦️"], 81: ["Rain showers", "🌧️"], 82: ["Violent showers", "⛈️"],
  85: ["Snow showers", "🌨️"], 86: ["Snow showers", "❄️"], 95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm + hail", "⛈️"],
  99: ["Thunderstorm + hail", "⛈️"],
};
const REGIONAL = new Set(["MQ", "OH", "OO", "YX", "9E", "QX", "ZW", "C5", "G7", "PT", "EV", "YV", "CP"]);
// Keep in sync with HOLIDAYS in pipeline/features.py
const HOLIDAYS = ["2025-05-26", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25", "2026-01-01", "2026-04-05",
  "2026-05-25", "2026-07-04", "2026-09-07", "2026-11-26", "2026-12-25", "2027-01-01", "2027-03-28",
  "2027-05-31", "2027-07-04", "2027-09-06", "2027-11-25", "2027-12-25"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const $ = (id) => document.getElementById(id);
const cache = {};
// A network error isn't cached, so the next lookup retries it (a missing file, HTTP 404, is cached as null)
const getJSON = (url) => (cache[url] ??= fetch(url).then((r) => (r.ok ? r.json() : null))
  .catch((err) => { delete cache[url]; throw err; }));
// The model loads in the background; a failed load is retried on the next lookup
let modelLoad;
const loadModel = () => (modelLoad ??= getJSON("data/model.json").then((m) => {
  if (!m) throw new Error("model.json unavailable");
  return (model = new DelayModel(m));
}).catch((err) => { modelLoad = undefined; throw err; }));

let model, stats, airports, carriers, metrics, map, mapLayers = [];
// Cloudflare Worker (worker/) that returns a flight number's scheduled route on a date from a live
// schedule API. Empty = off: lookups use only the BTS schedules, which lag ~2 months.
const LIVE_URL = "https://will-my-flight-be-delayed.ken-j.workers.dev/";
let setMode;

async function init() {
  const today = new Date();
  $("date").value = isoDate(today);
  $("examples").innerHTML = "Try " + EXAMPLES.map((e) => `<button type="button" class="btn">${e}</button>`).join("");
  $("examples").onclick = (e) => {
    if (e.target.classList.contains("btn")) { $("flight").value = e.target.textContent; run(); }
  };
  $("search").onsubmit = (e) => { e.preventDefault(); run(); };
  $("route-search").onsubmit = (e) => {
    e.preventDefault();
    runRoute().catch((err) => { console.error(err); showError("Something went wrong loading schedules. Please try again."); });
  };
  $("route-date").value = $("date").value;
  setMode = (route) => {
    $("mode-num").classList.toggle("active", !route);
    $("mode-route").classList.toggle("active", route);
    $("search").hidden = route; $("route-search").hidden = !route; $("examples").hidden = route;
    $("matches").hidden = true; $("error").hidden = true;
  };
  // Airlines reuse flight numbers, and our schedules lag the BTS release by ~2 months, so a number
  // can point to last season's route. Let the user jump to a route search for the same airline.
  $("route-check-btn").onclick = () => {
    const brand = $("route-check-btn").dataset.brand;
    setMode(true);
    $("result").hidden = true;
    if ([...$("airline").options].some((o) => o.value === brand)) $("airline").value = brand;
    $("route-date").value = $("date").value;
    $("from").value = ""; $("to").value = "";
    $("from").focus();
  };
  $("mode-num").onclick = () => setMode(false);
  $("mode-route").onclick = () => setMode(true);

  try {
    [stats, airports, carriers, metrics] = await Promise.all(
      ["data/stats.json", "data/airports.json", "data/carriers.json", "data/metrics.json"].map(getJSON));
    if (!stats || !airports || !carriers || !metrics) throw new Error("site data missing");
  } catch (err) {
    console.error(err);
    return showError("Couldn't load the flight data. Please refresh the page.");
  }
  renderAbout();
  const brands = Object.keys(PARTNERS).filter((c) => carriers[c] || PARTNERS[c].some((p) => carriers[p]));
  $("airline").innerHTML = `<option value="">Any airline</option>` + brands.concat(Object.keys(carriers).filter((c) => !brands.includes(c) && !Object.values(PARTNERS).flat().includes(c)))
    .map((c) => `<option value="${c}">${carriers[c]?.name ?? c}</option>`).join("");
  $("airport-list").innerHTML = Object.entries(airports).sort((a, b) => b[1].flights - a[1].flights)
    .map(([code, a]) => `<option value="${code} · ${a.city ?? ""}${a.region ? ", " + a.region : ""}"></option>`).join("");
  loadModel().catch((err) => console.error(err));

  const q = new URLSearchParams(location.search);
  if (q.get("flight")) {
    $("flight").value = q.get("flight");
    if (q.get("date")) $("date").value = q.get("date");
    run();
  }
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseDate(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); }
function fmtTime(hhmm) {
  const h = Math.floor(hhmm / 100) % 24, m = hhmm % 100;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function fmtDur(min) { return `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`; }
const pct = (x, d = 0) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);

function parseFlight(raw) {
  let s = raw.toUpperCase().trim();
  for (const [name, code] of Object.entries(NAME_TO_CODE)) if (s.startsWith(name)) s = code + s.slice(name.length);
  s = s.replace(/AIRLINES?|AIR LINES|AIRWAYS/g, "").replace(/[\s-]/g, "");
  const m = s.match(/^([A-Z0-9]{2})(\d{1,4})$/);
  return m ? { carrier: m[1], num: String(Number(m[2])) } : null;
}

async function findLegs({ carrier, num }) {
  const tryCarriers = [carrier, ...(PARTNERS[carrier] ?? [])];
  for (const c of tryCarriers) {
    const table = await getJSON(`data/flights/${c}.json`);
    if (table?.[num]) return { operator: c, legs: table[num] };
  }
  return null;
}

async function run() {
  $("error").hidden = true;
  const parsed = parseFlight($("flight").value);
  if (!parsed) return showError("Enter a flight like “DL 1234” (2-character airline code + number).");
  const date = $("date").value;
  const btn = $("search").querySelector("button");
  btn.disabled = true; btn.textContent = "Checking…";
  $("result").hidden = true;
  try {
    const [found, live] = await Promise.all([findLegs(parsed), lookupLive(parsed, date)]);
    if (live?.length) {
      history.replaceState(null, "", `?flight=${parsed.carrier}${parsed.num}&date=${date}`);
      const merged = await Promise.all(live.map((l) => mergeLiveLeg(parsed, found, l)));
      const legs = merged.map((m) => m.leg);
      renderLegTabs(parsed, { operator: merged[0].operator }, legs, legs, date);
      renderLiveCheck(parsed, merged[0], date);
      await showLeg(parsed, merged[0].operator, legs[0], date, false);
      return;
    }
    if (!found) return showError(`No recent schedule found for ${parsed.carrier} ${parsed.num}. It may be international, seasonal, or not reported to the BTS.`);
    history.replaceState(null, "", `?flight=${parsed.carrier}${parsed.num}&date=${date}`);
    const dow = (parseDate(date).getDay() + 6) % 7;
    const legs = found.legs;
    const flying = legs.filter((l) => l.dows & (1 << dow));
    renderLegTabs(parsed, found, legs, flying, date);
    renderRouteCheck(parsed, legs, flying);
    await showLeg(parsed, found.operator, flying[0] ?? legs[0], date, !flying.length);
  } catch (err) {
    console.error(err);
    showError("Something went wrong loading data. Please try again.");
  } finally {
    btn.disabled = false; btn.textContent = "Check";
  }
}

// Resolve "MSP", "MSP · Minneapolis, MN" or "Chicago" to a set of airport codes
function resolveAirports(text) {
  const t = text.trim().toUpperCase();
  const code = t.match(/^([A-Z]{3})\b/);
  if (code && airports[code[1]]) return new Set([code[1]]);
  const q = t.split("·").pop().split(",")[0].trim();
  return new Set(Object.entries(airports).filter(([, a]) => (a.city ?? "").toUpperCase() === q || (a.name ?? "").toUpperCase().includes(q))
    .map(([c]) => c));
}

const OPERATED_BY = Object.fromEntries(Object.entries(PARTNERS).flatMap(([b, ps]) => ps.map((p) => [p, b])));

async function runRoute() {
  $("error").hidden = true;
  $("result").hidden = true;
  const from = resolveAirports($("from").value), to = resolveAirports($("to").value);
  if (!from.size) return showError(`Couldn't find an airport matching “${$("from").value}”.`);
  if (!to.size) return showError(`Couldn't find an airport matching “${$("to").value}”.`);
  const brand = $("airline").value;
  const date = $("route-date").value;
  $("date").value = date;
  const dow = (parseDate(date).getDay() + 6) % 7;
  const codes = brand ? [brand, ...(PARTNERS[brand] ?? [])] : Object.keys(carriers);
  const found = [];
  await Promise.all(codes.map(async (c) => {
    const table = await getJSON(`data/flights/${c}.json`);
    for (const [num, legs] of Object.entries(table ?? {})) {
      for (const leg of legs) {
        if (from.has(leg.o) && to.has(leg.d) && leg.dows & (1 << dow)) {
          const mk = brand || OPERATED_BY[c] || c;
          found.push({ parsed: { carrier: mk, num }, operator: c, leg, legs });
        }
      }
    }
  }));
  found.sort((a, b) => a.leg.dep - b.leg.dep);
  const box = $("matches");
  box.hidden = false;
  if (!found.length) {
    box.innerHTML = "";
    return showError(`No ${brand ? carriers[brand]?.name + " " : ""}nonstop flights found on that route on ${DAYS[dow]}s in recent schedules.`);
  }
  box.innerHTML = `<p class="small muted">${found.length} nonstop flight${found.length > 1 ? "s" : ""} on ${DAYS[dow]}s. Pick one:</p>` +
    found.map((f, i) => `<button type="button" class="match" data-i="${i}">
      <span class="fn">${f.parsed.carrier} ${f.parsed.num}</span>
      <span class="meta">${f.leg.o} ${fmtTime(f.leg.dep)} → ${f.leg.d} ${fmtTime(f.leg.arr)} · ${fmtDur(f.leg.el)}${f.leg.ac && !["Unknown", "Other"].includes(f.leg.ac) ? " · " + f.leg.ac : ""}${f.operator !== f.parsed.carrier ? " · " + (carriers[f.operator]?.name ?? f.operator) : ""}</span>
      <span class="pr">${pct(1 - f.leg.hr)} on time</span></button>`).join("");
  box.onclick = async (e) => {
    const b = e.target.closest(".match");
    if (!b) return;
    box.querySelectorAll(".match").forEach((m) => m.classList.remove("active"));
    b.classList.add("active");
    const f = found[+b.dataset.i];
    $("legs").innerHTML = "";
    $("route-check").hidden = true;
    $("flight").value = `${f.parsed.carrier} ${f.parsed.num}`;
    history.replaceState(null, "", `?flight=${f.parsed.carrier}${f.parsed.num}&date=${date}`);
    try {
      await showLeg(f.parsed, f.operator, f.leg, date, false);
    } catch (err) {
      console.error(err);
      showError("Something went wrong loading data. Please try again.");
    }
  };
}

function showError(msg) { $("error").textContent = msg; $("error").hidden = false; }

async function lookupLive(parsed, date) {
  if (!LIVE_URL) return null;
  try {
    const r = await fetch(`${LIVE_URL}?flight=${parsed.carrier}${parsed.num}&date=${date}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.legs ?? []).filter((l) => airports[l.o] && airports[l.d] && l.dep != null);
  } catch { return null; } // slow, down or out of quota: fall back to the BTS schedules
}

const hhmmToMin = (t) => Math.floor(t / 100) * 60 + (t % 100);

function milesBetween(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return Math.round(3958.8 * 2 * Math.asin(Math.sqrt(h)));
}

// Live route + time, with history features from the BTS schedules: this flight number on the same
// route if it flew it, else the airline's regular flight on that route closest in departure time.
async function mergeLiveLeg(parsed, found, live) {
  let base = found?.legs.find((l) => l.o === live.o && l.d === live.d), operator = found?.operator, from = null;
  if (!base) {
    const brand = OPERATED_BY[parsed.carrier] ?? parsed.carrier;
    let bestGap = Infinity;
    for (const c of [brand, ...(PARTNERS[brand] ?? [])]) {
      const table = await getJSON(`data/flights/${c}.json`);
      for (const [num, legs] of Object.entries(table ?? {})) {
        for (const l of legs) {
          if (l.o !== live.o || l.d !== live.d) continue;
          // closest departure time, but a regular flight (10+ records) beats a one-off at any gap
          const gap = Math.abs(hhmmToMin(l.dep) - hhmmToMin(live.dep)) + ((l.hn ?? 0) < 10 ? 1e4 : 0);
          if (gap < bestGap) { bestGap = gap; base = l; operator = c; from = `${brand} ${num}`; }
        }
      }
    }
  }
  const b = base ?? { dows: 127, leg: null, turn: null, ac: null, age: null, seats: null, inb: null, fr: null, hr: null, hn: 0, ad: null, cx: null };
  const el = live.el ?? b.el ?? null;
  const arr = live.arr ?? (el != null ? ((Math.floor((hhmmToMin(live.dep) + el) / 60) % 24) * 100 + (hhmmToMin(live.dep) + el) % 60) : live.dep);
  return {
    operator: operator ?? parsed.carrier,
    from,
    leg: { ...b, o: live.o, d: live.d, dep: live.dep, arr, el: el ?? b.el, dist: b.dist ?? milesBetween(airports[live.o], airports[live.d]), live: true, reg: live.reg ?? null },
  };
}

function renderLiveCheck(parsed, m, date) {
  const text = $("route-check-text");
  const day = parseDate(date).toLocaleDateString("en", { month: "short", day: "numeric" });
  text.textContent = `Live schedule: ${parsed.carrier} ${parsed.num} on ${day} is `;
  const b = document.createElement("b"); b.textContent = `${m.leg.o} → ${m.leg.d} at ${fmtTime(m.leg.dep)}`; text.append(b);
  text.append(m.from ? `. Its history below comes from ${m.from}, the same route at a similar time.`
    : m.leg.hn ? "." : ". There's no history for this route in the government data, so the estimate leans on airport and airline averages.");
  $("route-check-btn").hidden = true;
  $("route-check").hidden = false;
}

function renderRouteCheck(parsed, legs, flying) {
  const shown = flying.length ? flying : legs;
  const routes = [...new Set(shown.map((l) => `${l.o} → ${l.d}`))];
  const through = metrics?.schedule_through
    ? parseDate(metrics.schedule_through).toLocaleDateString("en", { month: "long", day: "numeric" })
    : null;
  const list = routes.length > 2 ? `${routes.slice(0, 2).join(", ")} and ${routes.length - 2} more` : routes.join(" and ");
  const text = $("route-check-text");
  text.textContent = "";
  text.append(`${through ? `In schedules through ${through}, ` : "In recent schedules, "}${parsed.carrier} ${parsed.num} flew `);
  const b = document.createElement("b"); b.textContent = list; text.append(b);
  text.append(". Airlines reuse flight numbers, so if your ticket shows a different route, search by route instead.");
  $("route-check-btn").dataset.brand = OPERATED_BY[parsed.carrier] ?? parsed.carrier;
  $("route-check-btn").hidden = false;
  $("route-check").hidden = false;
}

function renderLegTabs(parsed, found, legs, flying, date) {
  const box = $("legs");
  box.innerHTML = "";
  if (legs.length < 2) return;
  legs.forEach((l, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn" + (l === (flying[0] ?? legs[0]) ? " active" : "");
    b.textContent = `${l.o} → ${l.d} · ${fmtTime(l.dep)}`;
    b.onclick = () => {
      box.querySelectorAll(".btn").forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      showLeg(parsed, found.operator, l, date, !flying.includes(l));
    };
    box.appendChild(b);
  });
}

async function fetchWeather(code, date) {
  const a = airports[code];
  const today = isoDate(new Date());
  const diff = (parseDate(date) - parseDate(today)) / 864e5;
  if (!a || diff > 15 || diff < -90) return null;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${a.lat}&longitude=${a.lon}` +
    `&hourly=${WX_VARS.join(",")}&timezone=auto&start_date=${date}&end_date=${date}` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch`;
  try {
    const j = await getJSON(url);
    return j?.hourly ?? null;
  } catch { return null; }
}

function wxAt(hourly, hour) {
  if (!hourly) return null;
  const o = {};
  for (const v of WX_VARS) o[v] = hourly[v]?.[hour] ?? null;
  const sum = (arr) => (arr ?? []).reduce((a, b) => a + (b ?? 0), 0);
  o.precipitation_day = sum(hourly.precipitation);
  o.snowfall_day = sum(hourly.snowfall);
  return o;
}

async function showLeg(parsed, operator, leg, date, notOnDate) {
  const depHour = Math.min(23, Math.floor(leg.dep / 100));
  const arrHour = Math.min(23, Math.floor(leg.arr / 100));
  const arrDate = leg.arr < leg.dep ? addDays(date, 1) : date;
  const [oHourly, dHourly] = await Promise.all([fetchWeather(leg.o, date), fetchWeather(leg.d, arrDate)]);
  const oWx = wxAt(oHourly, depHour), dWx = wxAt(dHourly, arrHour);
  await loadModel(); // throws if it can't load, so the caller shows an error instead of waiting forever

  const d = parseDate(date);
  const prior = stats.prior;
  const row = {
    month: d.getMonth() + 1, dow: (d.getDay() + 6) % 7, dep_hour: depHour, arr_hour: arrHour,
    distance: leg.dist, crs_elapsed: leg.el, leg_index: leg.leg,
    origin_hour_volume: stats.origin_hour_volume[`${leg.o}|${depHour}`] ?? 0,
    dest_hour_volume: stats.dest_hour_volume[`${leg.d}|${arrHour}`] ?? 0,
    carrier_rate: stats.carrier_rate[operator] ?? prior,
    origin_rate: stats.origin_rate[leg.o] ?? prior,
    dest_rate: stats.dest_rate[leg.d] ?? prior,
    route_rate: stats.route_rate[`${leg.o}|${leg.d}`] ?? prior,
    carrier_origin_rate: stats.carrier_origin_rate[`${operator}|${leg.o}`] ?? prior,
    origin_hour_rate: stats.origin_hour_rate[`${leg.o}|${depHour}`] ?? prior,
    flight_rate: leg.fr ?? prior,
    carrier_dest_rate: stats.carrier_dest_rate[`${operator}|${leg.d}`] ?? prior,
    aircraft_rate: stats.aircraft_rate[leg.ac] ?? prior,
    inbound_rate: stats.inbound_rate[leg.inb] ?? prior,
    turnaround: leg.turn, aircraft_age: leg.age, seats: leg.seats,
    regional: REGIONAL.has(operator) ? 1 : 0,
    days_to_holiday: Math.min(...HOLIDAYS.map((h) => Math.abs(Math.round((parseDate(h) - d) / 864e5)))),
  };
  for (const [side, wx] of [["o", oWx], ["d", dWx]]) {
    for (const k of [...WX_VARS, "precipitation_day", "snowfall_day"]) row[`${side}_${k}`] = wx ? wx[k] : null;
  }
  const res = model.predict(row);

  $("result").hidden = false;
  renderHeader(parsed, operator, leg);
  renderVerdict(res.p, notOnDate, date, !!(oWx && dWx));
  renderStats(leg, operator);
  renderDrivers(res, row);
  renderWeather(leg, oWx, dWx, date, arrDate);
  renderMap(leg);
  startLive(parsed, operator, leg, date);
  showFaa(leg, date);
  showInbound(leg, date);
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderHeader(parsed, operator, leg) {
  const o = airports[leg.o] ?? {}, d = airports[leg.d] ?? {};
  $("o-code").textContent = leg.o; $("d-code").textContent = leg.d;
  $("o-city").textContent = o.city ? `${o.city}, ${o.region}` : "";
  $("d-city").textContent = d.city ? `${d.city}, ${d.region}` : "";
  $("flightno").textContent = `${parsed.carrier} ${parsed.num}`;
  const mk = carriers[parsed.carrier]?.name ?? parsed.carrier;
  const op = carriers[operator]?.name ?? operator;
  $("carrier").textContent = operator === parsed.carrier ? mk : `${mk} · operated by ${op}`;
}

function renderVerdict(p, notOnDate, date, hasWx) {
  const avg = stats.prior;
  const color = p < 0.2 ? "var(--good)" : p < 0.35 ? "var(--mid)" : "var(--bad)";
  $("pct").textContent = pct(p);
  const fill = $("meter-fill");
  fill.style.background = color;
  fill.style.width = "0";
  requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = `${p * 100}%`)));
  $("meter-avg").style.left = `${avg * 100}%`;
  $("avg-label").textContent = `US average ${pct(avg)}`;
  const rel = p / avg;
  const label = p < 0.2 ? "Likely on time." : p < 0.35 ? "Some risk of a delay." : p < 0.5 ? "High risk of a delay." : "A delay is more likely than not.";
  const cmp = rel > 1.15 ? `That's ${rel.toFixed(1)}× the typical US flight.` : rel < 0.85 ? "That's below the typical US flight." : "That's about the same as the typical US flight.";
  $("verdict").style.borderColor = color;
  $("verdict").textContent = `${label} ${cmp}`;
  const notes = [];
  if (!hasWx) notes.push("No weather forecast is available for this date yet, so this estimate uses flight history only.");
  if (notOnDate) notes.push(`This flight didn't fly on ${DAYS[(parseDate(date).getDay() + 6) % 7]}s in recent schedules, so check your booking.`);
  if (metrics?.schedule_through) {
    const through = parseDate(metrics.schedule_through).toLocaleDateString("en", { month: "long", day: "numeric", year: "numeric" });
    notes.push(`Schedule details are from flights operated through ${through}, the latest government data, so confirm times with your airline.`);
  }
  $("verdict-note").textContent = notes.join(" ");
  $("verdict-note").hidden = !notes.length;
}

function renderStats(leg, operator) {
  const days = DAYS.filter((_, i) => leg.dows & (1 << i));
  const cards = [
    ["Departs", fmtTime(leg.dep), `${leg.o} local time`],
    ["Arrives", fmtTime(leg.arr), `${leg.d} local time${leg.arr < leg.dep ? " (+1 day)" : ""}`],
    ["Flight time", fmtDur(leg.el), "scheduled gate to gate"],
    ["Distance", `${leg.dist.toLocaleString()} mi`, `${Math.round(leg.dist * 1.609).toLocaleString()} km`],
    ["On-time record", leg.hr == null ? "–" : pct(1 - leg.hr), `${leg.hn ?? 0} flights in the past 2 years`],
    ["Avg delay when late", leg.ad ? `${leg.ad} min` : "–", "arrival delay"],
    ["Cancellation rate", pct(leg.cx, 1), "this flight, past 2 years"],
    ["Airline delay rate", pct(carriers[operator]?.rate), `${carriers[operator]?.name ?? operator}, all flights`],
    ["Aircraft", leg.ac && leg.ac !== "Unknown" && leg.ac !== "Other" ? leg.ac : "Varies",
      leg.age != null ? `usual type, about ${Math.round(leg.age)} years old` : "usual type on this flight"],
    ["Plane arrives from", leg.inb === "Overnight" ? "Overnight" : leg.inb ?? "–",
      leg.inb === "Overnight" ? "first flight of the plane's day" : leg.turn != null ? `about ${leg.turn} min to turn around` : ""],
    ["Operates", days.length === 7 ? "Daily" : days.join(" "), leg.leg ? `usually leg #${Math.round(leg.leg)} of the plane's day` : ""],
  ];
  $("stats").innerHTML = cards.map(([k, v, s]) => `<div class="stat"><div class="v">${v}</div><div class="l">${k}</div><div class="s">${s}</div></div>`).join("");
}

function describe(feature, value) {
  if (feature.startsWith("o_") || feature.startsWith("d_")) {
    const where = feature[0] === "o" ? "Origin" : "Destination";
    const k = feature.slice(2);
    return `${where} ${WX_LABELS[k] ?? k}`;
  }
  return LABELS[feature] ?? feature;
}
function fmtValue(feature, v) {
  if (v == null || Number.isNaN(v)) return "no forecast";
  const k = feature.replace(/^[od]_/, "");
  if (feature.endsWith("_rate")) return `${pct(v)} delayed`;
  if (feature === "dow") return DAYS[v];
  if (feature === "month") return new Date(2000, v - 1, 1).toLocaleString("en", { month: "long" });
  if (feature === "dep_hour" || feature === "arr_hour") return fmtTime(v * 100);
  if (feature === "distance") return `${v} mi`;
  if (feature === "crs_elapsed") return fmtDur(v);
  if (feature === "turnaround") return `${Math.round(v)} min`;
  if (feature === "aircraft_age") return `${Math.round(v)} years`;
  if (feature === "seats") return `${Math.round(v)} seats`;
  if (feature === "regional") return v ? "yes" : "no, mainline";
  if (feature === "days_to_holiday") return `${v} days`;
  if (feature === "leg_index") return `leg #${Math.round(v)}`;
  if (feature.endsWith("volume")) return `${v.toFixed(1)} flights/hr`;
  if (k === "weather_code") return WMO[v]?.[0] ?? `code ${v}`;
  if (k === "temperature_2m") return `${Math.round(v)}°F`;
  if (k.startsWith("wind")) return `${Math.round(v)} mph`;
  if (k.startsWith("cloud")) return `${Math.round(v)}%`;
  if (k.startsWith("precip") || k.startsWith("snow")) return `${v.toFixed(2)} in`;
  return String(v);
}

function renderDrivers(res, row) {
  const top = [...res.contributions].sort((a, b) => Math.abs(b.logit) - Math.abs(a.logit)).slice(0, 8);
  const max = Math.max(...top.map((c) => Math.abs(c.logit)), 0.01);
  $("drivers").innerHTML = top.map((c) => {
    const w = (Math.abs(c.logit) / max) * 50;
    const dir = c.logit > 0 ? "up" : "down";
    return `<div class="drv"><div>${describe(c.feature)}<small>${fmtValue(c.feature, row[c.feature])}</small></div>
      <div class="bar"><i class="${dir}" style="width:${w}%"></i></div></div>`;
  }).join("");
}

function wxCard(where, code, wx, time) {
  if (!wx) return `<div class="wx"><div class="where">${where} · ${code}</div><div class="t">No forecast yet</div></div>`;
  const [desc] = WMO[wx.weather_code] ?? ["–"];
  return `<div class="wx"><div class="where">${where} · ${code} · ${time}</div>
    <div class="t">${(WMO[wx.weather_code] ?? [])[1] ?? ""} ${Math.round(wx.temperature_2m)}°F, ${desc.toLowerCase()}</div>
    <ul><li>Wind ${Math.round(wx.wind_speed_10m)} mph, gusts ${Math.round(wx.wind_gusts_10m)} mph</li>
    <li>Cloud cover ${Math.round(wx.cloud_cover)}% (low clouds ${Math.round(wx.cloud_cover_low)}%)</li>
    <li>Precipitation ${wx.precipitation.toFixed(2)} in that hour, ${wx.precipitation_day.toFixed(2)} in that day</li>
    ${wx.snowfall_day > 0 ? `<li>Snow ${wx.snowfall_day.toFixed(1)} in that day</li>` : ""}</ul></div>`;
}

function wxGlance(wx) {
  if (!wx) return "";
  const [desc, icon] = WMO[wx.weather_code] ?? ["", "🌡️"];
  const windy = wx.wind_gusts_10m >= 30 ? " · 💨 " + Math.round(wx.wind_gusts_10m) + " mph" : "";
  return `<span title="${desc}">${icon} ${Math.round(wx.temperature_2m)}°F${windy}</span>`;
}

function renderWeather(leg, oWx, dWx) {
  $("o-wx").innerHTML = wxGlance(oWx); $("d-wx").innerHTML = wxGlance(dWx);
  $("weather").innerHTML = wxCard("Departure", leg.o, oWx, fmtTime(leg.dep)) + wxCard("Arrival", leg.d, dWx, fmtTime(leg.arr));
}

// ---------- Map ----------
const rad = (x) => (x * Math.PI) / 180, deg = (x) => (x * 180) / Math.PI;
function greatCircle(a, b, n = 128) {
  const [φ1, λ1, φ2, λ2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    pts.push([deg(Math.atan2(z, Math.hypot(x, y))), deg(Math.atan2(y, x))]);
  }
  return pts;
}
function bearing(p, q) {
  const [φ1, φ2, Δλ] = [rad(p[0]), rad(q[0]), rad(q[1] - p[1])];
  return deg(Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)));
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
let tiles;
function setTiles() {
  tiles?.remove();
  const style = document.documentElement.dataset.theme === "light" ? "World_Light_Gray_Base" : "World_Dark_Gray_Base";
  tiles = L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${style}/MapServer/tile/{z}/{y}/{x}`, {
    attribution: "Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors", maxZoom: 12,
  }).addTo(map);
}
const PLANE_SVG = `<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" stroke="#fff" stroke-width=".8" d="M12 2c.8 0 1.3.9 1.3 2v5.2l7.7 4.6v2l-7.7-2.3v4.8l2.2 1.7V22L12 21l-3.5 1v-1.9l2.2-1.7v-4.8L3 14.8v-2l7.7-4.6V4c0-1.1.5-2 1.3-2z"/></svg>`;
let anim;

function renderMap(leg) {
  const o = airports[leg.o], d = airports[leg.d];
  $("map").hidden = typeof L === "undefined"; // map library blocked or offline: skip the map, keep the forecast
  if (!o || !d || $("map").hidden) return;
  if (!map) {
    map = L.map("map", { zoomControl: false, attributionControl: true, worldCopyJump: true, scrollWheelZoom: false });
    setTiles();
  }
  const accent = css("--accent");
  mapLayers.forEach((l) => l.remove());
  cancelAnimationFrame(anim);
  let pts = greatCircle([o.lat, o.lon], [d.lat, d.lon]);
  // Keep longitudes continuous so routes near the antimeridian (e.g. Hawaii/Alaska) don't wrap
  for (let i = 1; i < pts.length; i++) while (pts[i][1] - pts[i - 1][1] > 180) pts[i][1] -= 360;
  for (let i = 1; i < pts.length; i++) while (pts[i][1] - pts[i - 1][1] < -180) pts[i][1] += 360;

  const glow = L.polyline(pts, { color: accent, weight: 8, opacity: 0.15 }).addTo(map);
  const line = L.polyline(pts, { color: accent, weight: 2.5, dashArray: "6 8" }).addTo(map);
  const dot = (p, code) => L.circleMarker(p, { radius: 6, color: "#fff", weight: 2, fillColor: accent, fillOpacity: 1 })
    .bindTooltip(code, { permanent: true, direction: "top", className: "ap-label", offset: [0, -6] }).addTo(map);
  const icon = L.divIcon({ className: "", html: `<div style="color:${accent};line-height:0">${PLANE_SVG}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  const plane = L.marker(pts[0], { icon, interactive: false }).addTo(map);
  routePts = pts;
  stopLive();
  decoPlane = plane;
  mapLayers = [glow, line, dot(pts[0], leg.o), dot(pts[pts.length - 1], leg.d), plane];
  map.invalidateSize();
  map.fitBounds(line.getBounds(), { padding: [50, 50] });

  const dur = 6000;
  let t0;
  const step = (t) => {
    t0 ??= t;
    const f = ((t - t0) % (dur + 1200)) / dur;
    const k = Math.min(pts.length - 2, Math.floor(Math.min(f, 1) * (pts.length - 1)));
    plane.setLatLng(pts[k + 1 > pts.length - 1 ? k : k + 1]);
    const el = plane.getElement()?.firstChild;
    if (el) el.style.transform = `rotate(${bearing(pts[k], pts[k + 1])}deg)`;
    anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

// ---------- FAA airport delays (relayed by the Vercel function; the FAA feed has no CORS headers) ----------
async function showFaa(leg, date) {
  const box = $("faa"); box.hidden = true;
  const today = isoDate(new Date());
  if (date < addDays(today, -1) || date > addDays(today, 1)) return; // the FAA feed is "right now" only
  try {
    const base = (typeof POS_URL !== "undefined" ? POS_URL : "").replace(/\/api\/position.*$/, "");
    if (!base) return;
    const j = await (await fetch(`${base}/api/faa?airports=${leg.o},${leg.d}`, { signal: AbortSignal.timeout(8000) })).json();
    if (!j.delays?.length) return;
    const name = (c) => airports[c]?.city ?? c;
    const lines = j.delays.map((d) => {
      const where = `${name(d.airport)} (${d.airport})`;
      const trend = d.trend === "increasing" ? ", and getting longer" : d.trend === "decreasing" ? ", but easing" : "";
      return `<b>${where}:</b> ${d.text}${trend}${d.reason ? ` (${d.reason})` : ""}.`;
    });
    $("faa-text").innerHTML = `<b>FAA airport status right now</b><br>${lines.join("<br>")}<small>From the FAA's live airport status feed. This is today's situation at the airport and is not part of the model's estimate below.</small>`;
    box.hidden = false;
  } catch { /* FAA feed unavailable: show nothing */ }
}

// ---------- Live aircraft position ----------
// Positions come from a small Vercel function (flight-position repo): browsers can't read ADS-B feeds directly
// and the free feeds refuse Cloudflare Workers.
const TEST_REG = location.hostname === "localhost" ? new URLSearchParams(location.search).get("reg") : null; // local testing only
const POS_API = "https://flight-position.vercel.app/api/position";
const POS_URL = (location.hostname === "localhost" && new URLSearchParams(location.search).get("live")) || POS_API;
const ICAO = { AA: "AAL", DL: "DAL", UA: "UAL", WN: "SWA", AS: "ASA", B6: "JBU", NK: "NKS", F9: "FFT", G4: "AAY", HA: "HAL",
  SY: "SCX", YX: "RPA", OO: "SKW", MQ: "ENY", "9E": "EDV", OH: "JIA", YV: "ASH", QX: "QXE", CP: "CPZ", ZW: "AWI",
  G7: "GJS", PT: "PDT", EV: "ASQ", MX: "MXY", XP: "VXP", "3M": "SIL" };
let routePts = [], decoPlane, livePlane, liveTrail, liveTimer, liveMisses = 0, liveCtx;

function stopLive() {
  clearInterval(liveTimer); liveTimer = null; liveMisses = 0;
  livePlane?.remove(); liveTrail?.remove(); livePlane = liveTrail = null;
  const note = $("live-note"); if (note) note.hidden = true;
}

function kmBetween(a, b) {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function startLive(parsed, operator, leg, date) {
  if (!POS_URL || !map || !routePts.length) return;
  const today = isoDate(new Date());
  if (date < addDays(today, -1) || date > addDays(today, 1)) return;
  const prefixes = [...new Set([parsed.carrier, operator].map((c) => ICAO[c]).filter(Boolean))];
  const callsigns = prefixes.map((p) => `${p}${parsed.num}`);
  if (!callsigns.length && !leg.reg && !TEST_REG) return;
  liveCtx = { callsigns, leg, reg: TEST_REG || leg.reg || null };
  const tick = () => { if (!document.hidden) pollLive(); };
  tick();
  liveTimer = setInterval(tick, 20000);
}

async function pollLive() {
  const ctx = liveCtx; if (!ctx) return;
  for (const cs of ctx.callsigns) {
    try {
      const r = await fetch(`${POS_URL}${POS_URL.includes("?") ? "&" : "?"}callsign=${cs}`);
      const j = await r.json();
      if (ctx !== liveCtx) return;
      if (j.unavailable) { liveMisses = 99; continue; }
      if (!j.found) continue;
      const here = [j.lat, j.lon];
      const near = Math.min(...routePts.map((p) => kmBetween(here, p)));
      if (near > 500) continue; // same callsign, different flight that day
      liveMisses = 0;
      return drawLive(j, here);
    } catch { /* feed unavailable: treat as a miss */ }
  }
  if (ctx !== liveCtx) return;
  if (ctx.reg && !livePlane) {
    try {
      const j = await (await fetch(`${POS_URL}${POS_URL.includes("?") ? "&" : "?"}reg=${ctx.reg}`)).json();
      if (ctx !== liveCtx) return;
      if (j.found) { liveMisses = 0; return drawLive(j, [j.lat, j.lon], true); }
    } catch { /* feed unavailable */ }
  }
  if (++liveMisses >= 12) { clearInterval(liveTimer); liveTimer = null; }
  const note = $("live-note");
  if (liveMisses >= 99) return; // tracking feed unavailable: stay quiet
  if (!livePlane && note) { note.textContent = "Live position shows here once the flight is in the air."; note.hidden = false; }
}


function planeDetails(j) {
  const title = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Inc|Llc|Co)\b\.?/g, "").replace(/\bA-(\d)/, "A$1").replace(/\s+/g, " ").trim();
  const parts = [];
  const model = j.model ? title(j.model) : j.type;
  if (model) {
    const age = j.year ? new Date().getFullYear() - j.year : null;
    parts.push(`${model}${j.year ? `, built ${j.year}${age >= 1 ? ` (${age} years old)` : ""}` : ""}${j.operator ? `, registered to ${title(j.operator)}` : ""}.`);
  }
  if (j.alt_ft === 0) parts.push("On the ground.");
  else if (j.climb_fpm >= 500) parts.push(`Climbing at ${Math.round(j.climb_fpm / 100) * 100} ft/min.`);
  else if (j.climb_fpm <= -500) parts.push(`Descending at ${Math.round(-j.climb_fpm / 100) * 100} ft/min.`);
  else if (j.alt_ft >= 25000) {
    parts.push(j.target_alt_ft != null && j.target_alt_ft < j.alt_ft - 1500
      ? `Cruising, and the autopilot is set to descend to ${j.target_alt_ft.toLocaleString()} ft.` : "Cruising level.");
  }
  return parts.join(" ");
}

function drawLive(j, here, inbound = false) {
  cancelAnimationFrame(anim); decoPlane?.remove(); decoPlane = null;
  const warm = css("--warm");
  let k = 0, best = Infinity;
  routePts.forEach((p, i) => { const d = kmBetween(here, p); if (d < best) { best = d; k = i; } });
  const html = `<div style="color:${warm};line-height:0;transform:rotate(${j.track ?? bearing(routePts[k], routePts[Math.min(k + 1, routePts.length - 1)])}deg)">${PLANE_SVG.replace("26", "32").replace("26", "32")}</div>`;
  const icon = L.divIcon({ className: "live-plane", html, iconSize: [32, 32], iconAnchor: [16, 16] });
  const tip = `${inbound ? "Your plane " + (j.reg ?? "") + " · " : ""}${j.callsign ?? ""} · ${j.alt_ft === 0 ? "on the ground" : j.alt_ft != null ? j.alt_ft.toLocaleString() + " ft" : ""}${j.speed_kt ? " · " + Math.round(j.speed_kt * 1.15078) + " mph" : ""}`;
  if (livePlane) { livePlane.setLatLng(here); livePlane.setIcon(icon); livePlane.setTooltipContent(tip); }
  else livePlane = L.marker(here, { icon, zIndexOffset: 1000 }).bindTooltip(tip, { direction: "top", offset: [0, -14] }).addTo(map);
  liveTrail?.remove(); liveTrail = null;
  if (!inbound) liveTrail = L.polyline(routePts.slice(0, k + 1), { color: warm, weight: 3, opacity: 0.9 }).addTo(map);
  else map.fitBounds(L.latLngBounds([...routePts, here]), { padding: [50, 50] });
  const note = $("live-note");
  if (note && inbound) {
    const mi = Math.round(kmBetween(here, routePts[0]) * 0.621371);
    const mph = j.speed_kt ? Math.round(j.speed_kt * 1.15078) : 0;
    const toward = j.track != null && Math.abs(((bearing(here, routePts[0]) - j.track + 540) % 360) - 180) < 45;
    const eta = j.alt_ft === 0 ? " It is on the ground right now." : (toward && mph > 100 ? ` Heading this way at ${mph} mph, it is about ${Math.max(1, Math.round(mi / mph * 60))} minutes away.` : " It is flying another route right now.");
    note.textContent = `Your plane (${j.reg}${j.type ? ", " + j.type : ""}) is right now ${mi.toLocaleString()} miles from ${routePts.length ? ($("o-code").textContent || "the departure airport") : "the departure airport"}, still flying as ${j.callsign ?? "another flight"}.${eta}`;
    note.hidden = false;
  } else if (note) {
    const age = j.updated > 5 ? ` · position ${j.updated}s old` : "";
    note.textContent = `Live: ${j.callsign} at ${j.alt_ft != null ? j.alt_ft.toLocaleString() + " ft" : "unknown altitude"}${j.speed_kt ? ", " + Math.round(j.speed_kt * 1.15078) + " mph" : ""}${age}. Updates every 20 seconds.`;
    note.hidden = false;
  }
  const det = planeDetails(j), note2 = $("live-note");
  if (note2 && !note2.hidden && det) { const s = document.createElement("span"); s.textContent = det; note2.append(document.createElement("br"), s); }
}

// ---------- Inbound aircraft ----------
// The plane flying this departure is the one that just flew in from leg.inb (the schedule data's inbound origin).
// Its live position comes from the tail number; lateness = estimated ETA at the departure airport versus the
// scheduled arrival (departure time minus this flight's usual turn time). Times use the airport's local clock,
// approximated from its state, so minute-level numbers are estimates.
const STATE_TZ = { AK: "America/Anchorage", HI: "Pacific/Honolulu", AZ: "America/Phoenix", CA: "America/Los_Angeles",
  NV: "America/Los_Angeles", OR: "America/Los_Angeles", WA: "America/Los_Angeles", CO: "America/Denver", NM: "America/Denver",
  UT: "America/Denver", WY: "America/Denver", MT: "America/Denver", ID: "America/Denver", TX: "America/Chicago",
  KS: "America/Chicago", NE: "America/Chicago", SD: "America/Chicago", ND: "America/Chicago", OK: "America/Chicago",
  MN: "America/Chicago", IA: "America/Chicago", MO: "America/Chicago", AR: "America/Chicago", LA: "America/Chicago",
  MS: "America/Chicago", AL: "America/Chicago", IL: "America/Chicago", WI: "America/Chicago", TN: "America/New_York",
  KY: "America/New_York", MI: "America/New_York", IN: "America/New_York", FL: "America/New_York" };
// States split by a time-zone line: airports west of the longitude use the second zone.
const SPLIT_TZ = { TX: [-106.5, "America/Denver"], KS: [-101, "America/Denver"], NE: [-102, "America/Denver"],
  SD: [-101.5, "America/Denver"], ND: [-101, "America/Denver"], ID: [-116.6, "America/Los_Angeles"],
  FL: [-85, "America/Chicago"], TN: [-85.5, "America/Chicago"], KY: [-87.2, "America/Chicago"],
  MI: [-87, "America/Chicago"], IN: [-87, "America/Chicago"] };
function airportTz(code) {
  const a = airports[code];
  if (!a) return null;
  const split = SPLIT_TZ[a.region];
  if (split && a.lon < split[0]) return split[1];
  return STATE_TZ[a.region] ?? null;
}
function localMinutes(tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return (get("hour") % 24) * 60 + get("minute");
}

let inboundTimer = null, inboundToken = null;

function hideInbound() {
  clearInterval(inboundTimer); inboundTimer = null; inboundToken = null;
  const box = $("inbound"); if (box) box.hidden = true;
}

function renderInbound(leg, date, j) {
  const o = airports[leg.o], inb = airports[leg.inb];
  if (!j?.found || j.lat == null || j.lon == null || !o || !inb) return false;
  const here = [j.lat, j.lon];
  const route = greatCircle([inb.lat, inb.lon], [o.lat, o.lon]);
  if (Math.min(...route.map((p) => kmBetween(here, p))) > 500) return false; // this tail is flying another leg
  const mi = Math.round(kmBetween(here, [o.lat, o.lon]) * 0.621371);
  const mph = j.speed_kt ? Math.round(j.speed_kt * 1.15078) : 0;
  const landed = j.alt_ft === 0 && kmBetween(here, [o.lat, o.lon]) < 20;
  const from = inb.city ?? leg.inb;
  const lines = [`Inbound plane ${leg.reg} is coming from ${from} (${leg.inb}).`];
  if (landed) lines.push(`It has already landed at ${leg.o}.`);
  else lines.push(mph > 100 ? `It is ${mi.toLocaleString()} miles out, flying ${mph} mph.` : `It is ${mi.toLocaleString()} miles out.`);
  const tz = airportTz(leg.o);
  if (!landed && mph > 100 && tz && leg.turn != null && date === isoDate(new Date())) {
    const sched = hhmmToMin(leg.dep) - Math.round(leg.turn);
    const diff = ((((sched - localMinutes(tz)) + 720) % 1440) + 1440) % 1440 - 720; // minutes until scheduled arrival (negative = already due)
    const late = Math.round(mi / mph * 60 - diff);
    if (late >= 5) lines.push(`The inbound plane is about ${late} min late.`);
    else if (late <= -5) lines.push(`The inbound plane is about ${-late} min early.`);
    else lines.push("The inbound plane is on schedule.");
    lines.push("Scheduled arrival is estimated from this flight's usual turn time, so the minutes are approximate.");
  }
  $("inbound-text").textContent = lines.join(" ");
  $("inbound").hidden = false;
  return landed ? "done" : "live"; // "done": already on the ground at the departure airport, nothing left to track
}

async function showInbound(leg, date) {
  hideInbound();
  const reg = TEST_REG || leg.reg;
  const today = isoDate(new Date());
  if (!reg || !POS_URL || !leg.inb || leg.inb === "Overnight" || date < addDays(today, -1) || date > addDays(today, 1)) return;
  const token = (inboundToken = {});
  const poll = async () => {
    if (document.hidden) return;
    try {
      const r = await fetch(`${POS_URL}${POS_URL.includes("?") ? "&" : "?"}reg=${encodeURIComponent(reg)}`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (token !== inboundToken) return;
      const state = renderInbound(leg, date, j);
      if (!state) { hideInbound(); return null; }
      if (state === "done") { clearInterval(inboundTimer); inboundTimer = null; }
      return state;
    } catch { if (token === inboundToken) hideInbound(); return null; } // feed unavailable or no data: show nothing
  };
  const state = await poll();
  if (state === "live" && token === inboundToken) inboundTimer = setInterval(poll, 60000);
}

// ---------- About ----------
function renderAbout() {
  if (!metrics) return;
  const r = metrics.results;
  const rows = [
    ["National average rate", r.baseline_overall_rate],
    ["Airline's historical rate", r.baseline_carrier_rate],
    ["Flight number's historical rate", r.baseline_flight_rate],
    ["This model (no weather)", r.selected_no_weather],
    ["This model (with weather)", r.selected_features, true],
  ];
  $("metrics").innerHTML = `<tr><th>Predictor</th><th>AUC (higher is better)</th><th>Brier (lower)</th><th>Log loss (lower)</th></tr>` +
    rows.map(([n, m, hl]) => `<tr class="${hl ? "hl" : ""}"><td>${n}</td><td>${m.auc.toFixed(3)}</td><td>${m.brier.toFixed(3)}</td><td>${m.logloss.toFixed(3)}</td></tr>`).join("");
  $("data-note").textContent = `Trained on ${metrics.n_flights.toLocaleString()} flights (${metrics.train_period[0]} to ${metrics.train_period[1]}). ` +
    `Schedules reflect flights operated in the 8 weeks up to ${metrics.schedule_through}; newer or changed flights may be missing. ` +
    (metrics.dropped.length ? `Features pruned by SHAP: ${metrics.dropped.join(", ")}.` : "");
  getJSON("data/scorecard.json").then((card) => {
    if (!card?.months?.length) return;
    const f = (x) => x.toFixed(3), pct = (x) => `${Math.round(x * 100)}%`;
    $("scorecard-table").innerHTML = `<tr><th>Month</th><th>Flights</th><th>AUC</th><th>AUC at validation</th><th>Flight-history AUC</th><th>Predicted / actual delay rate</th></tr>` +
      card.months.slice(-12).reverse().map((m) => `<tr><td>${m.month}</td><td>${m.n.toLocaleString()} (${pct(m.coverage)})</td><td>${f(m.auc)}</td>` +
        `<td>${f(m.validation_auc)}</td><td>${f(m.baseline_flight_rate_auc)}</td><td>${pct(m.mean_pred)} / ${pct(m.actual_rate)}</td></tr>`).join("");
    $("scorecard").hidden = false;
  });
  // BTS data lags ~2-3 months; past ~5 months the monthly retrain has likely stopped.
  const ageDays = (Date.now() - new Date(metrics.schedule_through)) / 86400000;
  if (ageDays > 150) {
    const b = document.createElement("div");
    b.className = "stale-banner";
    b.textContent = `Heads up: flight schedules are only current through ${metrics.schedule_through}, so newer flights may be missing.`;
    document.body.prepend(b);
  }
}

init();
