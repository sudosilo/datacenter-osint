const express = require("express");
const cors = require("cors");
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 3000;

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter"
];
const POWER_LAYER = "https://geo.epa.ohio.gov/arcgis/rest/services/Hosted/PowerPlants_US_EIA/FeatureServer/0";
const DROUGHT_LAYER = "https://services5.arcgis.com/0OTVzJS4K09zlixn/arcgis/rest/services/USDM_current/FeatureServer/0";
const GHG_BASE = "https://data.epa.gov/efservice/PUB_DIM_FACILITY/STATE/=/";
const METEO = "https://api.open-meteo.com/v1/forecast";
const SAT = {
  west: "https://cdn.star.nesdis.noaa.gov/GOES18/ABI/CONUS/GEOCOLOR/1250x750.jpg",
  east: "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/CONUS/GEOCOLOR/1250x750.jpg"
};

const DAY = 60 * 60 * 24;
const TTL = { osm: DAY, power: DAY * 7, industry: DAY * 7, drought: 60 * 60 * 6, plume: 60 * 60 };
const REFRESH_MS = 1000 * 60 * 60 * 12;

const STATE_NAMES = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",
  DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",
  IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",
  MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",
  NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",
  NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",
  RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",
  VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"
};
const NAME_TO_ABBR = {};
Object.keys(STATE_NAMES).forEach((k) => (NAME_TO_ABBR[STATE_NAMES[k].toLowerCase()] = k));
const ALL_STATES = Object.keys(STATE_NAMES);

const SCOPES = {
  west: ["CA", "AZ", "NV"],
  CA: ["CA"],
  AZ: ["AZ"],
  NV: ["NV"],
  southwest: ["CA", "AZ", "NV", "NM", "UT", "CO", "TX", "OR", "ID", "WY"],
  us: null
};

const INDUSTRY = [
  ["325193","Ethanol plant",700000],
  ["324110","Petroleum refinery",3000000],
  ["3241","Petroleum products plant",400000],
  ["3221","Pulp and paper mill",2500000],
  ["3222","Paper products plant",300000],
  ["3344","Semiconductor fab",2000000],
  ["2122","Metal mine",5000000],
  ["2123","Mineral mine",800000],
  ["3311","Iron and steel mill",1500000],
  ["3312","Steel products plant",600000],
  ["3313","Aluminum plant",1200000],
  ["3314","Copper or nonferrous smelter",1500000],
  ["325","Chemical plant",1000000],
  ["3273","Cement plant",250000],
  ["3274","Lime plant",150000],
  ["3272","Glass plant",150000],
  ["3112","Grain or oilseed mill",600000],
  ["3113","Sugar refinery",800000],
  ["3116","Meat processing plant",500000],
  ["311","Food processing plant",400000],
  ["3121","Beverage plant",300000]
];

let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
  redis.on("error", (e) => console.error("redis", e.message));
}
const memory = new Map();

async function cacheGet(key) {
  if (redis) {
    try {
      const v = await redis.get(key);
      return v ? JSON.parse(v) : null;
    } catch (e) {
      console.error("cacheGet", e.message);
    }
  }
  const m = memory.get(key);
  if (m && m.expires > Date.now()) return m.value;
  return null;
}

async function cacheSet(key, value, ttl) {
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(value), "EX", ttl);
      return;
    } catch (e) {
      console.error("cacheSet", e.message);
    }
  }
  memory.set(key, { value, expires: Date.now() + ttl * 1000 });
}

async function cached(key, ttl, fn) {
  const hit = await cacheGet(key);
  if (hit) return hit;
  const val = await fn();
  await cacheSet(key, val, ttl);
  return val;
}

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error("status " + res.status);
  return res.json();
}

function titleCase(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\s+County$/i, "")
    .replace(/\s+Parish$/i, "");
}

app.use(cors());
app.use(express.json());

function scopeOf(req) {
  const s = req.query.scope || "west";
  return s in SCOPES ? s : null;
}

/* ---------- data centers and cooling towers ---------- */

function overpassQuery(states) {
  const areas = states ? states.map((s) => "US-" + s) : ["US"];
  let q = "[out:json][timeout:300];";
  areas.forEach((a, i) => {
    const key = a === "US" ? "ISO3166-1" : "ISO3166-2";
    q += `area["${key}"="${a}"]->.a${i};`;
  });
  q += "(";
  areas.forEach((a, i) => {
    ["telecom", "building"].forEach((k) => {
      q += `node["${k}"="data_center"](area.a${i});`;
      q += `way["${k}"="data_center"](area.a${i});`;
    });
  });
  q += ")->.dc;.dc out geom tags;(";
  areas.forEach((a, i) => {
    q += `node["man_made"="cooling_tower"](area.a${i});`;
    q += `way["man_made"="cooling_tower"](area.a${i});`;
  });
  q += ")->.ct;.ct out center tags;";
  return q;
}

async function runOverpass(query) {
  let last = null;
  for (const endpoint of OVERPASS) {
    try {
      return await getJSON(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query)
      });
    } catch (e) {
      last = e;
      console.error("overpass failed", endpoint, e.message);
    }
  }
  throw last || new Error("all overpass endpoints failed");
}

function polyArea(geom) {
  if (!geom || geom.length < 4) return null;
  const midLat = geom.reduce((s, p) => s + p.lat, 0) / geom.length;
  const mx = 111320 * Math.cos((midLat * Math.PI) / 180);
  const my = 111320;
  let sum = 0;
  for (let i = 0; i < geom.length - 1; i++) {
    const a = geom[i];
    const b = geom[i + 1];
    sum += a.lon * mx * (b.lat * my) - b.lon * mx * (a.lat * my);
  }
  const m2 = Math.abs(sum / 2);
  return m2 > 40 ? m2 * 10.7639 : null;
}

function normaliseOverpass(raw) {
  const dc = [];
  const tower = [];
  const seen = new Set();
  for (const e of raw.elements || []) {
    const t = e.tags || {};
    const isDc = t.telecom === "data_center" || t.building === "data_center";
    const isTw = t.man_made === "cooling_tower";
    if (!isDc && !isTw) continue;

    let lat = null;
    let lon = null;
    let sqft = null;
    if (e.type === "node") {
      lat = e.lat;
      lon = e.lon;
    } else if (e.geometry && e.geometry.length) {
      lat = e.geometry.reduce((s, p) => s + p.lat, 0) / e.geometry.length;
      lon = e.geometry.reduce((s, p) => s + p.lon, 0) / e.geometry.length;
      if (isDc) sqft = polyArea(e.geometry);
    } else if (e.center) {
      lat = e.center.lat;
      lon = e.center.lon;
    }
    if (lat == null || lon == null) continue;

    const key = (isDc ? "d" : "t") + lat.toFixed(4) + "," + lon.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);

    const rec = {
      id: "osm/" + e.type + "/" + e.id,
      name: t.name || t.operator || t.brand || (isDc ? "Unnamed data center" : "Cooling tower"),
      operator: t.operator || t.brand || "",
      state: "",
      county: "",
      lat,
      lon,
      sqft,
      type: isDc ? "dc" : "tower",
      height: t.height ? parseFloat(t.height) : null
    };
    (isDc ? dc : tower).push(rec);
  }
  return { dc, tower };
}

app.get("/api/osm", async (req, res) => {
  const scope = scopeOf(req);
  if (!scope) return res.status(400).json({ error: "unknown scope" });
  try {
    const r = await cached("dco:osm:" + scope, TTL.osm, async () =>
      normaliseOverpass(await runOverpass(overpassQuery(SCOPES[scope])))
    );
    res.json({ scope, dc: r.dc, tower: r.tower });
  } catch (e) {
    console.error("osm", e.message);
    res.status(502).json({ error: "contributor query failed" });
  }
});

/* ---------- power plants ---------- */

function splitThermal(a) {
  const tech = (a.tech_desc || "") + " " + (a.source_des || "");
  const parts = [];
  const add = (kind, mw) => {
    if (mw > 0) parts.push({ kind, mw });
  };
  add("nuclear", +a.nuclear_mw || 0);
  add("coal", +a.coal_mw || 0);
  const ng = +a.ng_mw || 0;
  if (ng > 0) {
    if (/combined cycle/i.test(tech)) add("ngcc", ng);
    else if (/steam turbine/i.test(tech)) add("gassteam", ng);
  }
  const oil = +a.crude_mw || 0;
  if (oil > 0 && /steam turbine/i.test(tech)) add("gassteam", oil);
  const bio = +a.bio_mw || 0;
  if (bio > 0 && /wood|municipal solid waste|other waste biomass|steam/i.test(tech)) add("bio", bio);
  add("geo", +a.geo_mw || 0);
  return parts;
}

async function arcgisAll(layer, params) {
  let out = [];
  let offset = 0;
  for (;;) {
    const p = new URLSearchParams({
      ...params,
      f: "json",
      resultOffset: String(offset),
      resultRecordCount: "2000"
    });
    const j = await getJSON(layer + "/query?" + p.toString());
    if (j.error) throw new Error(j.error.message || "query error");
    const feats = j.features || [];
    out = out.concat(feats);
    if (feats.length === 2000 || j.exceededTransferLimit) offset += feats.length;
    else break;
  }
  return out;
}

async function fetchPower(scope) {
  const states = SCOPES[scope];
  const thermal = "(coal_mw>0 OR ng_mw>0 OR nuclear_mw>0 OR bio_mw>0 OR geo_mw>0 OR crude_mw>0)";
  const where = states
    ? "statename IN (" + states.map((s) => "'" + STATE_NAMES[s].replace(/'/g, "''") + "'").join(",") + ") AND " + thermal
    : thermal;
  const feats = await arcgisAll(POWER_LAYER, {
    where,
    outFields:
      "plant_code,plant_name,utility_na,county,city,statename,primsource,total_mw,coal_mw,ng_mw,crude_mw,nuclear_mw,bio_mw,geo_mw,tech_desc,source_des,latitude,longitude",
    returnGeometry: "false",
    orderByFields: "fid"
  });
  const out = [];
  for (const f of feats) {
    const a = f.attributes || {};
    const lat = +a.latitude;
    const lon = +a.longitude;
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const parts = splitThermal(a);
    if (!parts.length) continue;
    out.push({
      id: "eia/" + a.plant_code,
      name: a.plant_name || "Power plant",
      operator: a.utility_na || "",
      state: NAME_TO_ABBR[(a.statename || "").toLowerCase()] || "",
      county: titleCase(a.county),
      city: a.city || "",
      lat,
      lon,
      type: "power",
      parts,
      totalMW: +a.total_mw || 0,
      tech: a.tech_desc || "",
      plantCode: a.plant_code
    });
  }
  return out;
}

app.get("/api/power", async (req, res) => {
  const scope = scopeOf(req);
  if (!scope) return res.status(400).json({ error: "unknown scope" });
  try {
    const list = await cached("dco:power:" + scope, TTL.power, () => fetchPower(scope));
    res.json({ scope, count: list.length, facilities: list });
  } catch (e) {
    console.error("power", e.message);
    res.status(502).json({ error: "power plant inventory unavailable" });
  }
});

/* ---------- heavy industry ---------- */

function classify(naics) {
  const s = String(naics || "");
  for (const row of INDUSTRY) if (s.indexOf(row[0]) === 0) return row;
  return null;
}

function lowerKeys(o) {
  const r = {};
  for (const k of Object.keys(o)) r[k.toLowerCase()] = o[k];
  return r;
}

async function ghgState(st) {
  for (const y of [2024, 2023]) {
    try {
      const rows = await getJSON(GHG_BASE + st + "/YEAR/=/" + y + "/JSON");
      if (rows && rows.length) return rows;
    } catch (e) {
      console.error("ghg", st, y, e.message);
    }
  }
  return [];
}

async function fetchIndustryState(st) {
  return cached("dco:ghg:" + st, TTL.industry, async () => {
    const rows = await ghgState(st);
    const out = [];
    const seen = new Set();
    for (const raw of rows) {
      const r = lowerKeys(raw);
      const cls = classify(r.naics_code);
      if (!cls) continue;
      const lat = parseFloat(r.latitude);
      const lon = parseFloat(r.longitude);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const id = r.facility_id || lat.toFixed(4) + lon.toFixed(4);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id: "ghg/" + id,
        name: titleCase(r.facility_name) || cls[1],
        operator: titleCase(r.parent_company || ""),
        state: (r.state || st).toUpperCase(),
        county: titleCase(r.county),
        city: titleCase(r.city),
        lat,
        lon,
        type: "industry",
        cls: cls[1],
        typical: cls[2],
        naics: r.naics_code,
        year: r.year
      });
    }
    return out;
  });
}

app.get("/api/industry", async (req, res) => {
  const scope = scopeOf(req);
  if (!scope) return res.status(400).json({ error: "unknown scope" });
  const states = SCOPES[scope] || ALL_STATES;
  try {
    let all = [];
    for (let i = 0; i < states.length; i += 4) {
      const batch = await Promise.all(states.slice(i, i + 4).map((s) => fetchIndustryState(s).catch(() => [])));
      batch.forEach((b) => (all = all.concat(b)));
    }
    res.json({ scope, count: all.length, facilities: all });
  } catch (e) {
    console.error("industry", e.message);
    res.status(502).json({ error: "facility register unavailable" });
  }
});

/* ---------- drought ---------- */

app.get("/api/drought", async (req, res) => {
  try {
    const gj = await cached("dco:drought", TTL.drought, () =>
      getJSON(
        DROUGHT_LAYER +
          "/query?" +
          new URLSearchParams({
            where: "1=1",
            outFields: "DM,MapDate",
            f: "geojson",
            outSR: "4326",
            maxAllowableOffset: "0.03",
            geometryPrecision: "3"
          }).toString()
      )
    );
    res.set("Cache-Control", "public, max-age=3600");
    res.json(gj);
  } catch (e) {
    console.error("drought", e.message);
    res.status(502).json({ error: "drought monitor unavailable" });
  }
});

/* ---------- plume ---------- */

async function windAt(lat, lon, hourOffset) {
  const url =
    METEO +
    "?latitude=" + lat.toFixed(3) +
    "&longitude=" + lon.toFixed(3) +
    "&hourly=wind_speed_850hPa,wind_direction_850hPa,wind_speed_10m,wind_direction_10m" +
    "&forecast_days=3&timezone=UTC";
  const j = await getJSON(url);
  if (!j.hourly) return null;
  const now = Date.now();
  let base = j.hourly.time.findIndex((t) => new Date(t + "Z").getTime() >= now);
  if (base < 0) base = 0;
  const i = Math.min(base + hourOffset, j.hourly.time.length - 1);
  let speed = j.hourly.wind_speed_850hPa && j.hourly.wind_speed_850hPa[i];
  let dir = j.hourly.wind_direction_850hPa && j.hourly.wind_direction_850hPa[i];
  if (speed == null || dir == null) {
    speed = j.hourly.wind_speed_10m[i];
    dir = j.hourly.wind_direction_10m[i];
  }
  if (speed == null || dir == null) return null;
  return { speed, dir };
}

async function buildTrack(lat, lon, hours, stepH) {
  const track = [{ t: 0, lat, lon }];
  let elapsed = 0;
  for (let s = 0; s < Math.floor(hours / stepH); s++) {
    const last = track[track.length - 1];
    let w;
    try {
      w = await windAt(last.lat, last.lon, elapsed);
    } catch (e) {
      break;
    }
    if (!w) break;
    const toward = ((w.dir + 180) * Math.PI) / 180;
    const ms = w.speed / 3.6;
    const dt = stepH * 3600;
    const dLat = (ms * Math.cos(toward) * dt) / 111320;
    const dLon = (ms * Math.sin(toward) * dt) / (111320 * Math.cos((last.lat * Math.PI) / 180));
    elapsed += stepH;
    track.push({ t: elapsed, lat: last.lat + dLat, lon: last.lon + dLon, speed: w.speed, dir: w.dir });
  }
  return track;
}

app.get("/api/plume", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const hours = Math.min(parseInt(req.query.hours || "48", 10), 72);
  if (!isFinite(lat) || !isFinite(lon)) return res.status(400).json({ error: "lat and lon required" });
  const bucket = Math.floor(Date.now() / (1000 * 60 * 60));
  const key = `dco:plume:${lat.toFixed(2)}:${lon.toFixed(2)}:${hours}:${bucket}`;
  try {
    const track = await cached(key, TTL.plume, () => buildTrack(lat, lon, hours, 3));
    res.json({ track });
  } catch (e) {
    console.error("plume", e.message);
    res.status(502).json({ error: "wind service failed" });
  }
});

/* ---------- satellite ---------- */

app.get("/api/satellite", async (req, res) => {
  try {
    const upstream = await fetch(req.query.view === "east" ? SAT.east : SAT.west);
    if (!upstream.ok) throw new Error("status " + upstream.status);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=240");
    res.send(buf);
  } catch (e) {
    console.error("satellite", e.message);
    res.status(502).end();
  }
});

/* ---------- health ---------- */

app.get("/api/health", async (req, res) => {
  let redisState = "not configured";
  if (redis) {
    try {
      await redis.ping();
      redisState = "connected";
    } catch (e) {
      redisState = "error";
    }
  }
  res.json({ ok: true, redis: redisState, scopes: Object.keys(SCOPES), time: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res
    .type("text/plain")
    .send("data center osint api. endpoints: /api/osm /api/power /api/industry /api/drought /api/plume /api/satellite /api/health");
});

async function warm() {
  for (const scope of ["west", "CA", "AZ", "NV"]) {
    try {
      await cacheSet("dco:power:" + scope, await fetchPower(scope), TTL.power);
      console.log("power warmed", scope);
    } catch (e) {
      console.error("power warm", scope, e.message);
    }
    try {
      const r = normaliseOverpass(await runOverpass(overpassQuery(SCOPES[scope])));
      await cacheSet("dco:osm:" + scope, r, TTL.osm);
      console.log("osm warmed", scope, r.dc.length, r.tower.length);
    } catch (e) {
      console.error("osm warm", scope, e.message);
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
  for (const st of ["CA", "AZ", "NV"]) {
    try {
      await fetchIndustryState(st);
    } catch (e) {
      console.error("ghg warm", st, e.message);
    }
  }
}

app.listen(PORT, () => {
  console.log("listening on " + PORT);
  setTimeout(warm, 8000);
  setInterval(warm, REFRESH_MS);
});
