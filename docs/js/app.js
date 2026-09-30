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
const getJSON = (url) => (cache[url] ??= fetch(url).then((r) => (r.ok ? r.json() : null)));

let model, stats, airports, carriers, metrics, map, mapLayers = [];

async function init() {
  const today = new Date();
  $("date").value = isoDate(today);
  $("examples").innerHTML = "Try " + EXAMPLES.map((e) => `<button type="button" class="btn">${e}</button>`).join("");
  $("examples").onclick = (e) => {
    if (e.target.classList.contains("btn")) { $("flight").value = e.target.textContent; run(); }
  };
  const setTheme = (t) => {
    document.documentElement.dataset.theme = t;
    $("theme").textContent = t === "dark" ? "Light" : "Dark";
    try { localStorage.setItem("theme", t); } catch {}
    if (map) setTiles();
  };
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch {}
  setTheme(saved ?? "dark");
  $("theme").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("search").onsubmit = (e) => { e.preventDefault(); run(); };
  $("route-search").onsubmit = (e) => { e.preventDefault(); runRoute(); };
  $("route-date").value = $("date").value;
  const setMode = (route) => {
    $("mode-num").classList.toggle("active", !route);
    $("mode-route").classList.toggle("active", route);
    $("search").hidden = route; $("route-search").hidden = !route; $("examples").hidden = route;
    $("matches").hidden = true; $("error").hidden = true;
  };
  $("mode-num").onclick = () => setMode(false);
  $("mode-route").onclick = () => setMode(true);

  [stats, airports, carriers, metrics] = await Promise.all(
    ["data/stats.json", "data/airports.json", "data/carriers.json", "data/metrics.json"].map(getJSON));
  renderAbout();
  const brands = Object.keys(PARTNERS).filter((c) => carriers[c] || PARTNERS[c].some((p) => carriers[p]));
  $("airline").innerHTML = `<option value="">Any airline</option>` + brands.concat(Object.keys(carriers).filter((c) => !brands.includes(c) && !Object.values(PARTNERS).flat().includes(c)))
    .map((c) => `<option value="${c}">${carriers[c]?.name ?? c}</option>`).join("");
  $("airport-list").innerHTML = Object.entries(airports).sort((a, b) => b[1].flights - a[1].flights)
    .map(([code, a]) => `<option value="${code} · ${a.city ?? ""}${a.region ? ", " + a.region : ""}"></option>`).join("");
  getJSON("data/model.json").then((m) => (model = new DelayModel(m)));

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
    const found = await findLegs(parsed);
    if (!found) return showError(`No recent schedule found for ${parsed.carrier} ${parsed.num}. It may be international, seasonal, or not reported to the BTS.`);
    history.replaceState(null, "", `?flight=${parsed.carrier}${parsed.num}&date=${date}`);
    const dow = (parseDate(date).getDay() + 6) % 7;
    const legs = found.legs;
    const flying = legs.filter((l) => l.dows & (1 << dow));
    renderLegTabs(parsed, found, legs, flying, date);
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
    $("flight").value = `${f.parsed.carrier} ${f.parsed.num}`;
    history.replaceState(null, "", `?flight=${f.parsed.carrier}${f.parsed.num}&date=${date}`);
    await showLeg(f.parsed, f.operator, f.leg, date, false);
  };
}

function showError(msg) { $("error").textContent = msg; $("error").hidden = false; }

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
  while (!model) await new Promise((r) => setTimeout(r, 100));

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
    ["On-time record", pct(1 - leg.hr), `${leg.hn} flights in the past year`],
    ["Avg delay when late", leg.ad ? `${leg.ad} min` : "–", "arrival delay"],
    ["Cancellation rate", pct(leg.cx, 1), "this flight, past year"],
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
    <div class="t">${Math.round(wx.temperature_2m)}°F, ${desc.toLowerCase()}</div>
    <ul><li>Wind ${Math.round(wx.wind_speed_10m)} mph, gusts ${Math.round(wx.wind_gusts_10m)} mph</li>
    <li>Cloud cover ${Math.round(wx.cloud_cover)}% (low clouds ${Math.round(wx.cloud_cover_low)}%)</li>
    <li>Precipitation ${wx.precipitation.toFixed(2)} in that hour, ${wx.precipitation_day.toFixed(2)} in that day</li>
    ${wx.snowfall_day > 0 ? `<li>Snow ${wx.snowfall_day.toFixed(1)} in that day</li>` : ""}</ul></div>`;
}

function renderWeather(leg, oWx, dWx) {
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
  if (!o || !d) return;
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
