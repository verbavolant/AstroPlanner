import { useState, useCallback, useMemo, useEffect } from "react";

// ─── Astronomical utilities ───────────────────────────────────────────────────

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function toJulian(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function lstDegrees(jd, lonDeg) {
  const T = (jd - 2451545.0) / 36525;
  let gst = 280.46061837 + 360.98564736629 * (jd - 2451545) +
    0.000387933 * T * T - T * T * T / 38710000;
  gst = ((gst % 360) + 360) % 360;
  return ((gst + lonDeg) % 360 + 360) % 360;
}

function raDecToAltAz(ra, dec, lst, lat) {
  const ha = ((lst - ra) % 360 + 360) % 360;
  const haR = ha * DEG, decR = dec * DEG, latR = lat * DEG;
  const sinAlt = Math.sin(decR) * Math.sin(latR) +
    Math.cos(decR) * Math.cos(latR) * Math.cos(haR);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * RAD;
  const cosAz = (Math.sin(decR) - Math.sin(alt * DEG) * Math.sin(latR)) /
    (Math.cos(alt * DEG) * Math.cos(latR));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) * RAD;
  if (Math.sin(haR) > 0) az = 360 - az;
  return { alt, az };
}

// Interpolate horizon profile (array of 360 entries, index = azimuth degree)
function getHorizonAlt(horizonProfile, az) {
  if (!horizonProfile || horizonProfile.length === 0) return 0;
  const az0 = Math.floor(((az % 360) + 360) % 360);
  const az1 = (az0 + 1) % 360;
  const frac = az - az0;
  const h0 = horizonProfile[az0] ?? 0;
  const h1 = horizonProfile[az1] ?? 0;
  return h0 + (h1 - h0) * frac;
}

// Returns minutes above horizon (above custom horizon) during the night of given date
function visibleMinutes(ra, dec, lat, lon, date, horizonProfile) {
  // Astronomical night: civil approx from sunset+1h to sunrise-1h
  // We sample every 10 minutes across 12 hours centred at midnight
  const base = new Date(date);
  base.setHours(21, 0, 0, 0); // start 21:00 local approx
  let count = 0;
  for (let i = 0; i < 72; i++) { // 72 × 10 min = 12 hours
    const t = new Date(base.getTime() + i * 600000);
    const jd = toJulian(t);
    const lst = lstDegrees(jd, lon);
    const { alt, az } = raDecToAltAz(ra, dec, lst, lat);
    const horizAlt = getHorizonAlt(horizonProfile, az);
    if (alt > horizAlt + 5) count++; // 5° safety margin
  }
  return count * 10;
}

// Best transit time (approx HA=0)
function transitTime(ra, lat, lon, date) {
  for (let h = 18; h < 30; h += 0.1) {
    const t = new Date(date);
    t.setHours(0, 0, 0, 0);
    t.setTime(t.getTime() + h * 3600000);
    const jd = toJulian(t);
    const lst = lstDegrees(jd, lon);
    const ha = ((lst - ra + 180) % 360 + 360) % 360 - 180;
    if (Math.abs(ha) < 1.5) {
      return `${String(Math.round(h) % 24).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
    }
  }
  return "—";
}

function maxAltitude(ra, dec, lat, lon, date) {
  let maxA = -90;
  const base = new Date(date);
  base.setHours(18, 0, 0, 0);
  for (let i = 0; i < 96; i++) {
    const t = new Date(base.getTime() + i * 450000);
    const jd = toJulian(t);
    const lst = lstDegrees(jd, lon);
    const { alt } = raDecToAltAz(ra, dec, lst, lat);
    if (alt > maxA) maxA = alt;
  }
  return maxA;
}

// Build altitude curve from sunset to sunrise (samples every 10 min, 13 hours)
// Returns array of { hour, alt, az, horizAlt, visible }
function buildNightCurve(ra, dec, lat, lon, date, horizonProfile) {
  const base = new Date(date);
  base.setHours(19, 0, 0, 0); // start 19:00 local
  const steps = 78; // 78 × 10 min = 13 hours → until 08:00
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = new Date(base.getTime() + i * 600000);
    const jd = toJulian(t);
    const lst = lstDegrees(jd, lon);
    const { alt, az } = raDecToAltAz(ra, dec, lst, lat);
    const horizAlt = getHorizonAlt(horizonProfile, az);
    const hour = 19 + (i * 10) / 60; // fractional hour
    points.push({ hour, alt, az, horizAlt, visible: alt > horizAlt + 5 });
  }
  return points;
}

// ─── Supplementary Catalogue Parsers ─────────────────────────────────────────

function parseSharpless(csvText) {
  const lines = csvText.trim().split("\n").slice(1);
  return lines.map(line => {
    const p = line.split(";");
    if (p.length < 4) return null;
    const ra = parseFloat(p[1]), dec = parseFloat(p[2]);
    const size = parseFloat(p[3]) || 5;
    const notes = (p[5] || "").trim();
    if (isNaN(ra) || isNaN(dec)) return null;
    return {
      id: p[0].trim(), name: notes || p[0].trim(), catalogName: p[0].trim(),
      ra, dec, type: "Regione HII", typeCode: "HII",
      mag: 99, size, mode: "narrowband", filters: "Hα, OIII, SII",
      expHours: size > 60 ? "8–20h" : size > 20 ? "5–12h" : "3–8h",
      description: notes || "Nebulosa HII (Sharpless)",
      constellation: "",
    };
  }).filter(Boolean);
}

function parseBarnard(csvText) {
  const lines = csvText.trim().split("\n").slice(1);
  return lines.map(line => {
    const p = line.split(";");
    if (p.length < 4) return null;
    const ra = parseFloat(p[1]), dec = parseFloat(p[2]);
    const size = parseFloat(p[3]) || 5;
    const notes = (p[4] || "").trim();
    if (isNaN(ra) || isNaN(dec)) return null;
    return {
      id: p[0].trim(), name: notes || p[0].trim(), catalogName: p[0].trim(),
      ra, dec, type: "Nebulosa oscura", typeCode: "DN",
      mag: 99, size, mode: "broadband", filters: "LRGB / OSC",
      expHours: "4–10h",
      description: notes || "Nebulosa oscura (Barnard)",
      constellation: "",
    };
  }).filter(Boolean);
}

function parseAbellPN(csvText) {
  const lines = csvText.trim().split("\n").slice(1);
  return lines.map(line => {
    const p = line.split(";");
    if (p.length < 4) return null;
    const ra = parseFloat(p[1]), dec = parseFloat(p[2]);
    const size = parseFloat(p[3]) || 1;
    const mag = parseFloat(p[4]) || 99;
    const notes = (p[5] || "").trim();
    if (isNaN(ra) || isNaN(dec)) return null;
    return {
      id: p[0].trim(), name: notes || p[0].trim(), catalogName: p[0].trim(),
      ra, dec, type: "Nebulosa planetaria", typeCode: "PN",
      mag, size, mode: "narrowband", filters: "Hα, OIII",
      expHours: "6–15h",
      description: notes || "Planetaria debole (Abell)",
      constellation: "",
    };
  }).filter(Boolean);
}

function parseCollMel(csvText) {
  const lines = csvText.trim().split("\n").slice(1);
  return lines.map(line => {
    const p = line.split(";");
    if (p.length < 4) return null;
    const ra = parseFloat(p[1]), dec = parseFloat(p[2]);
    const size = parseFloat(p[3]) || 5;
    const mag = parseFloat(p[4]) || 8;
    const notes = (p[5] || "").trim();
    if (isNaN(ra) || isNaN(dec)) return null;
    return {
      id: p[0].trim(), name: notes || p[0].trim(), catalogName: p[0].trim(),
      ra, dec, type: "Ammasso aperto", typeCode: "OC",
      mag, size, mode: "broadband", filters: "LRGB / OSC",
      expHours: mag < 5 ? "1–3h" : "2–6h",
      description: notes || "Ammasso aperto",
      constellation: "",
    };
  }).filter(Boolean);
}

// ─── OpenNGC Fetch & Parser ───────────────────────────────────────────────────

// Maps OpenNGC type codes → our internal type labels + imaging mode
const ONGC_TYPE_MAP = {
  "GX":   { type: "Galassia",              mode: "broadband",  filters: "LRGB / OSC" },
  "GX?":  { type: "Galassia (incerta)",    mode: "broadband",  filters: "LRGB / OSC" },
  "OC":   { type: "Ammasso aperto",        mode: "broadband",  filters: "LRGB / OSC" },
  "GC":   { type: "Ammasso globulare",     mode: "broadband",  filters: "LRGB / OSC" },
  "PN":   { type: "Nebulosa planetaria",   mode: "narrowband", filters: "Hα, OIII" },
  "BN":   { type: "Nebulosa a riflessione",mode: "broadband",  filters: "LRGB / OSC" },
  "EN":   { type: "Nebulosa a emissione",  mode: "narrowband", filters: "Hα, OIII, SII" },
  "RN":   { type: "Nebulosa a riflessione",mode: "broadband",  filters: "LRGB / OSC" },
  "SNR":  { type: "Resto di supernova",    mode: "narrowband", filters: "Hα, OIII" },
  "SR":   { type: "Resto di supernova",    mode: "narrowband", filters: "Hα, OIII" },
  "DN":   { type: "Nebulosa oscura",       mode: "broadband",  filters: "LRGB / OSC" },
  "HII":  { type: "Regione HII",           mode: "narrowband", filters: "Hα, OIII, SII" },
  "Neb":  { type: "Nebulosa",             mode: "narrowband", filters: "Hα, OIII" },
  "NF":   { type: "Non trovato",           mode: "broadband",  filters: "—" },
  "MWSC": { type: "Ammasso stellare",      mode: "broadband",  filters: "LRGB / OSC" },
  "OCl":  { type: "Ammasso aperto",        mode: "broadband",  filters: "LRGB / OSC" },
  "GCl":  { type: "Ammasso globulare",     mode: "broadband",  filters: "LRGB / OSC" },
  "Cl+N": { type: "Ammasso + nebulosa",    mode: "narrowband", filters: "Hα, OIII, SII" },
  "*Ass": { type: "Associazione stellare", mode: "broadband",  filters: "LRGB / OSC" },
  "EmN":  { type: "Nebulosa a emissione",  mode: "narrowband", filters: "Hα, OIII, SII" },
  "RfN":  { type: "Nebulosa a riflessione",mode: "broadband",  filters: "LRGB / OSC" },
  "ISM":  { type: "Mezzo interstellare",   mode: "narrowband", filters: "Hα, OIII, SII" },
  "PG":   { type: "Galassia compatta",     mode: "broadband",  filters: "LRGB / OSC" },
  "2G":   { type: "Coppia di galassie",    mode: "broadband",  filters: "LRGB / OSC" },
  "3G":   { type: "Tripletta di galassie", mode: "broadband",  filters: "LRGB / OSC" },
  "CG":   { type: "Gruppo di galassie",    mode: "broadband",  filters: "LRGB / OSC" },
};

// Suggested exposure hours by type
function suggestExp(typeCode, mag) {
  const m = parseFloat(mag) || 10;
  if (["EN","HII","SNR","SR","PN","Cl+N","EmN","ISM"].includes(typeCode)) {
    return m < 8 ? "3–8h" : m < 11 ? "5–12h" : "8–20h";
  }
  if (["GX","GX?","2G","3G","CG","PG"].includes(typeCode)) {
    return m < 9 ? "4–8h" : m < 11 ? "6–12h" : "10–20h";
  }
  if (["GC","OC","OCl","GCl","MWSC"].includes(typeCode)) {
    return m < 7 ? "1–3h" : "2–5h";
  }
  return "3–8h";
}

// Convert RA "HH:MM:SS.ss" → decimal degrees
function raHMStoDeg(s) {
  if (!s) return null;
  const p = s.trim().split(":");
  if (p.length < 2) return null;
  const h = parseFloat(p[0]), m = parseFloat(p[1]), sec = parseFloat(p[2] || 0);
  return (h + m / 60 + sec / 3600) * 15;
}

// Convert Dec "+DD:MM:SS.s" → decimal degrees
function decDMStoDeg(s) {
  if (!s) return null;
  const sign = s.trim().startsWith("-") ? -1 : 1;
  const p = s.trim().replace(/^[+-]/, "").split(":");
  if (p.length < 2) return null;
  const d = parseFloat(p[0]), m = parseFloat(p[1]), sec = parseFloat(p[2] || 0);
  return sign * (d + m / 60 + sec / 3600);
}

// Parse OpenNGC CSV text → array of our objects
function parseOpenNGC(csvText) {
  const lines = csvText.split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(";").map(h => h.trim().replace(/^"|"$/g, ""));
  const idx = (name) => header.indexOf(name);

  const iName   = idx("Name");
  const iType   = idx("Type");
  const iRA     = idx("RA");
  const iDec    = idx("Dec");
  const iMaj    = idx("MajAx");    // arcmin
  const iMag    = idx("V-Mag");
  const iBmag   = idx("B-Mag");
  const iCommon = idx("Common names");
  const iM      = idx("M");        // Messier number
  const iConst  = idx("Const");

  const objects = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(";");
    if (row.length < 5) continue;

    const rawName = (row[iName] || "").trim().replace(/^"|"$/g, "");
    if (!rawName) continue;

    const typeCode = (row[iType] || "").trim().replace(/^"|"$/g, "");
    // Skip non-visual / undefined / duplicate entries
    if (!typeCode || typeCode === "NF" || typeCode === "*" || typeCode === "D*") continue;

    const ra  = raHMStoDeg((row[iRA]  || "").replace(/^"|"$/g, "").trim());
    const dec = decDMStoDeg((row[iDec] || "").replace(/^"|"$/g, "").trim());
    if (ra === null || dec === null) continue;

    const majorAxis = parseFloat((row[iMaj] || "").replace(/^"|"$/g, "")) || 1;
    const vMag = parseFloat((row[iMag] || row[iBmag] || "").replace(/^"|"$/g, "")) || 15;
    const commonName = (row[iCommon] || "").replace(/^"|"$/g, "").trim();
    const messier = (row[iM] || "").replace(/^"|"$/g, "").trim();
    const constellation = (row[iConst] || "").replace(/^"|"$/g, "").trim();

    // Build display name: prefer common name, fallback to NGC/IC id
    const displayName = commonName || rawName;

    // Messier cross-reference id
    const mId = messier ? `M${messier}` : null;

    const typeInfo = ONGC_TYPE_MAP[typeCode] || { type: typeCode, mode: "broadband", filters: "LRGB / OSC" };

    objects.push({
      id: rawName,
      mId,
      name: displayName,
      catalogName: rawName,
      ra,
      dec,
      type: typeInfo.type,
      typeCode,
      mag: vMag,
      size: majorAxis,
      mode: typeInfo.mode,
      filters: typeInfo.filters,
      expHours: suggestExp(typeCode, vMag),
      description: [
        commonName && commonName !== rawName ? commonName : null,
        constellation ? `Cost. ${constellation}` : null,
        mId ? `Messier ${messier}` : null,
      ].filter(Boolean).join(" · ") || typeInfo.type,
      constellation,
    });
  }
  return objects;
}

// Curated fallback catalogue (used when fetch fails)
const CATALOGUE_FALLBACK = [
  { id: "M42",    name: "Nebulosa di Orione",    ra: 83.82,  dec: -5.39,  type: "Nebulosa a emissione",  mag: 4.0,  size: 65,  mode: "narrowband", filters: "Hα, OIII, SII", expHours: "3–6h",  description: "Icona invernale, ricca in Hα" },
  { id: "M1",     name: "Nebulosa del Granchio",  ra: 83.63,  dec: 22.01,  type: "Resto di supernova",    mag: 8.4,  size: 7,   mode: "narrowband", filters: "Hα, OIII",       expHours: "4–8h",  description: "Filamenti delicati, ottima per narrowband" },
  { id: "NGC7293",name: "Nebulosa Elica",         ra: 337.41, dec: -20.84, type: "Nebulosa planetaria",   mag: 7.3,  size: 28,  mode: "narrowband", filters: "Hα, OIII",       expHours: "5–10h", description: "La più grande nebulosa planetaria del cielo" },
  { id: "M57",    name: "Nebulosa Anello",        ra: 283.4,  dec: 33.03,  type: "Nebulosa planetaria",   mag: 8.8,  size: 1.4, mode: "narrowband", filters: "Hα, OIII",       expHours: "3–5h",  description: "Gioiello estivo in Lyra" },
  { id: "M27",    name: "Nebulosa Manubrio",      ra: 299.9,  dec: 22.72,  type: "Nebulosa planetaria",   mag: 7.4,  size: 8,   mode: "narrowband", filters: "Hα, OIII, SII", expHours: "4–8h",  description: "Grandissima planetaria, SHO spettacolare" },
  { id: "IC1805", name: "Nebulosa Cuore",         ra: 38.2,   dec: 61.45,  type: "Nebulosa a emissione",  mag: 6.5,  size: 150, mode: "narrowband", filters: "Hα, OIII, SII", expHours: "8–15h", description: "SHO palette sorprendente" },
  { id: "NGC2244",name: "Nebulosa Rosetta",       ra: 97.9,   dec: 4.97,   type: "Nebulosa a emissione",  mag: 6.0,  size: 80,  mode: "narrowband", filters: "Hα, OIII, SII", expHours: "6–12h", description: "Struttura circolare magnificente" },
  { id: "NGC6992",name: "Velo Est (Cigno)",       ra: 313.8,  dec: 31.73,  type: "Resto di supernova",    mag: 7.0,  size: 60,  mode: "narrowband", filters: "Hα, OIII",       expHours: "6–12h", description: "Filamenti sottilissimi" },
  { id: "NGC7000",name: "Nebulosa Nord America",  ra: 314.0,  dec: 44.5,   type: "Nebulosa a emissione",  mag: 4.0,  size: 120, mode: "narrowband", filters: "Hα, OIII, SII", expHours: "6–12h", description: "Estiva/autunnale, grandissima" },
  { id: "M31",    name: "Galassia di Andromeda",  ra: 10.68,  dec: 41.27,  type: "Galassia spirale",      mag: 3.4,  size: 190, mode: "broadband",  filters: "LRGB / OSC",     expHours: "4–10h", description: "Target autunnale per eccellenza" },
  { id: "M51",    name: "Galassia Vortice",       ra: 202.5,  dec: 47.2,   type: "Galassia spirale",      mag: 8.4,  size: 11,  mode: "broadband",  filters: "LRGB / OSC",     expHours: "6–12h", description: "Interazione con NGC5195" },
  { id: "M81",    name: "Galassia di Bode",       ra: 148.9,  dec: 69.07,  type: "Galassia spirale",      mag: 6.9,  size: 21,  mode: "broadband",  filters: "LRGB / OSC",     expHours: "5–10h", description: "Coppia con M82" },
  { id: "M13",    name: "Ammasso Ercole",         ra: 250.4,  dec: 36.46,  type: "Ammasso globulare",     mag: 5.8,  size: 20,  mode: "broadband",  filters: "LRGB / OSC",     expHours: "2–4h",  description: "Il più bello ammasso globulare nord" },
  { id: "M45",    name: "Pleiadi",                ra: 56.87,  dec: 24.11,  type: "Ammasso aperto",        mag: 1.6,  size: 120, mode: "broadband",  filters: "LRGB / OSC",     expHours: "3–8h",  description: "Nebulosità blu attorno alle stelle" },
];

// ─── Horizon profile parser ───────────────────────────────────────────────────


function parseHorizonCSV(text) {
  // Expected: two columns, azimuth (0-359) and altitude in degrees
  // Lines can be "az,alt" or "az;alt"
  const lines = text.trim().split(/\r?\n/);
  const profile = new Array(360).fill(0);
  for (const line of lines) {
    const parts = line.split(/[,;\t ]+/);
    if (parts.length < 2) continue;
    const az = parseFloat(parts[0]);
    const alt = parseFloat(parts[1]);
    if (isNaN(az) || isNaN(alt)) continue;
    profile[Math.round(((az % 360) + 360) % 360)] = alt;
  }
  return profile;
}

// ─── Score helper ─────────────────────────────────────────────────────────────

function scoreObject(obj, lat, lon, date, horizonProfile) {
  const mins = visibleMinutes(obj.ra, obj.dec, lat, lon, date, horizonProfile);
  const maxAlt = maxAltitude(obj.ra, obj.dec, lat, lon, date);
  const transit = transitTime(obj.ra, lat, lon, date);
  const nightCurve = buildNightCurve(obj.ra, obj.dec, lat, lon, date, horizonProfile);
  // Score: 0–100
  const score = Math.min(100, Math.round((mins / 360) * 60 + (maxAlt / 90) * 40));
  return { ...obj, mins, maxAlt: Math.round(maxAlt), transit, score, nightCurve };
}

// ─── FOV Sky Simulation (procedural SVG) ─────────────────────────────────────
// Draws a realistic synthetic sky view with the object and FOV rectangle.
// No external requests — works entirely offline/in sandbox.

// Deterministic seeded PRNG (mulberry32)
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Visual parameters per object type
const OBJ_VISUALS = {
  "Nebulosa a emissione":   { color: "#e05050", glow: "#ff6060", shape: "cloud",   label: "Neb. emissione" },
  "Resto di supernova":     { color: "#60b0ff", glow: "#80d0ff", shape: "filament", label: "SNR" },
  "Nebulosa planetaria":    { color: "#40e0c0", glow: "#60ffdd", shape: "ring",    label: "Neb. planetaria" },
  "Nebulosa + ammasso":     { color: "#e06040", glow: "#ff8060", shape: "cloud",   label: "Neb. + ammasso" },
  "Nebulosa bilobata":      { color: "#d060d0", glow: "#f080f0", shape: "bilobed", label: "Nebulosa" },
  "Galassia spirale":       { color: "#ffe0a0", glow: "#fff0c0", shape: "galaxy",  label: "Galassia spirale" },
  "Galassia irregolare":    { color: "#ffc060", glow: "#ffe080", shape: "irreg",   label: "Galassia irr." },
  "Galassia di Seyfert":    { color: "#ffe0a0", glow: "#fff0c0", shape: "galaxy",  label: "Galassia" },
  "Galassia a taglio":      { color: "#e8d080", glow: "#fff0b0", shape: "edge",    label: "Galassia edge-on" },
  "Ammasso + nebulosa riflessione": { color: "#a0c0ff", glow: "#c0d8ff", shape: "cluster", label: "Ammasso + neb." },
  "Ammasso globulare":      { color: "#ffffc0", glow: "#ffffff", shape: "globular", label: "Amm. globulare" },
  "Ammasso aperto doppio":  { color: "#e0f0ff", glow: "#ffffff", shape: "open2",   label: "Amm. aperto doppio" },
};

function FovImage({ ra, dec, objSize, fovData, objName, objType }) {
  const IMG = 260;
  const vis = OBJ_VISUALS[objType] || { color: "#aaaaaa", glow: "#cccccc", shape: "cloud", label: objType };
  const rng = seededRng(Math.round(ra * 1000 + Math.abs(dec) * 100));

  // Survey field (degrees): just enough to show object + some context + FOV
  const surveyDeg = useMemo(() => {
    const objDeg = Math.max(objSize * 2.5, 15) / 60;
    if (!fovData) return Math.min(5, Math.max(0.25, objDeg));
    const diagDeg = Math.sqrt(fovData.fovW ** 2 + fovData.fovH ** 2) / 60;
    return Math.min(5, Math.max(0.25, objDeg, diagDeg * 1.4));
  }, [fovData, objSize]);

  const arcminPerPx = (surveyDeg * 60) / IMG;

  // Object radius in pixels
  const objRpx = Math.max(3, Math.min(IMG * 0.42, (objSize / 2) / arcminPerPx));

  // FOV rectangle
  const fovRect = useMemo(() => {
    if (!fovData) return null;
    const rw = Math.min(IMG - 2, fovData.fovW / arcminPerPx);
    const rh = Math.min(IMG - 2, fovData.fovH / arcminPerPx);
    return { x: (IMG - rw) / 2, y: (IMG - rh) / 2, w: rw, h: rh };
  }, [fovData, arcminPerPx]);

  // Scale bar
  const scaleArcmin = surveyDeg * 60 > 120 ? 60 : surveyDeg * 60 > 40 ? 20 : surveyDeg * 60 > 10 ? 10 : surveyDeg * 60 > 3 ? 2 : 1;
  const scaleBarPx = scaleArcmin / arcminPerPx;

  // Generate background stars
  const stars = useMemo(() => {
    const arr = [];
    const count = 90 + Math.floor(rng() * 60);
    for (let i = 0; i < count; i++) {
      arr.push({
        x: rng() * IMG,
        y: rng() * IMG,
        r: 0.4 + rng() * rng() * 2.2,
        op: 0.3 + rng() * 0.7,
        // slight color tint
        h: Math.random() < 0.15 ? (rng() < 0.5 ? "#ffddaa" : "#aaddff") : "#ffffff",
      });
    }
    return arr;
  }, [ra, dec]);

  const cx = IMG / 2, cy = IMG / 2;

  // Draw the nebula/object shape
  const renderObject = () => {
    const { shape, color, glow } = vis;
    const r = objRpx;
    const id = `g${Math.round(ra * 10)}`;

    if (shape === "ring" || shape === "planetaria") {
      return (
        <g>
          <defs>
            <radialGradient id={`rg${id}`} cx="50%" cy="50%" r="50%">
              <stop offset="30%" stopColor={color} stopOpacity={0.0} />
              <stop offset="65%" stopColor={color} stopOpacity={0.55} />
              <stop offset="80%" stopColor={glow} stopOpacity={0.7} />
              <stop offset="100%" stopColor={color} stopOpacity={0.1} />
            </radialGradient>
          </defs>
          <ellipse cx={cx} cy={cy} rx={r} ry={r * 0.85}
            fill={`url(#rg${id})`} />
          <ellipse cx={cx} cy={cy} rx={r * 0.95} ry={r * 0.8}
            fill="none" stroke={glow} strokeWidth={Math.max(1, r * 0.18)} opacity={0.6} />
        </g>
      );
    }
    if (shape === "galaxy" || shape === "irreg") {
      const tilt = (rng() * 60 - 30) * Math.PI / 180;
      return (
        <g transform={`rotate(${tilt * 180 / Math.PI} ${cx} ${cy})`}>
          <defs>
            <radialGradient id={`gx${id}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={glow} stopOpacity={0.9} />
              <stop offset="30%" stopColor={color} stopOpacity={0.6} />
              <stop offset="70%" stopColor={color} stopOpacity={0.2} />
              <stop offset="100%" stopColor={color} stopOpacity={0.0} />
            </radialGradient>
          </defs>
          <ellipse cx={cx} cy={cy} rx={r} ry={r * 0.38} fill={`url(#gx${id})`} />
          <ellipse cx={cx} cy={cy} rx={r * 0.25} ry={r * 0.2}
            fill={glow} opacity={0.7} />
        </g>
      );
    }
    if (shape === "edge") {
      return (
        <g>
          <defs>
            <linearGradient id={`eg${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor={color} stopOpacity={0} />
              <stop offset="20%" stopColor={color} stopOpacity={0.7} />
              <stop offset="50%" stopColor={glow} stopOpacity={0.9} />
              <stop offset="80%" stopColor={color} stopOpacity={0.7} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <ellipse cx={cx} cy={cy} rx={r} ry={r * 0.12} fill={`url(#eg${id})`} />
          <line x1={cx - r} y1={cy} x2={cx + r} y2={cy}
            stroke="#111" strokeWidth={r * 0.08} opacity={0.5} />
        </g>
      );
    }
    if (shape === "globular") {
      const dots = [];
      const rng2 = seededRng(Math.round(dec * 1000));
      for (let i = 0; i < 60; i++) {
        const angle = rng2() * 2 * Math.PI;
        const dist = Math.pow(rng2(), 0.5) * r;
        dots.push({ x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist,
          s: 0.4 + rng2() * 0.8 });
      }
      return (
        <g>
          <defs>
            <radialGradient id={`gb${id}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={glow} stopOpacity={0.9} />
              <stop offset="60%" stopColor={color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0.0} />
            </radialGradient>
          </defs>
          <circle cx={cx} cy={cy} r={r} fill={`url(#gb${id})`} />
          {dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={d.s} fill="white" opacity={0.6} />)}
        </g>
      );
    }
    if (shape === "open2") {
      // Two overlapping clusters
      return (
        <g>
          {[-r*0.5, r*0.5].map((dx, ci) => {
            const rng3 = seededRng(ci * 1000 + Math.round(ra));
            const pts = Array.from({ length: 35 }, () => ({
              x: cx + dx + (rng3() - 0.5) * r * 1.2,
              y: cy + (rng3() - 0.5) * r * 1.2,
              s: 0.5 + rng3() * 1.2,
              op: 0.5 + rng3() * 0.5,
            }));
            return pts.map((p, i) => <circle key={`${ci}-${i}`} cx={p.x} cy={p.y} r={p.s} fill="white" opacity={p.op} />);
          })}
        </g>
      );
    }
    if (shape === "filament") {
      // Wispy filaments (SNR)
      const paths = [];
      const rng4 = seededRng(Math.round(ra * 7));
      for (let i = 0; i < 6; i++) {
        const a0 = (i / 6) * 2 * Math.PI + rng4() * 0.4;
        const pts = Array.from({ length: 12 }, (_, j) => {
          const a = a0 + (j / 11) * (Math.PI * 0.5) - Math.PI * 0.25;
          const dr = r * (0.75 + rng4() * 0.3);
          const jitter = (rng4() - 0.5) * r * 0.25;
          return `${cx + Math.cos(a) * dr + jitter},${cy + Math.sin(a) * dr + jitter}`;
        });
        paths.push(pts.join(" L "));
      }
      return (
        <g>
          <circle cx={cx} cy={cy} r={r * 1.05} fill="none" stroke={color} strokeWidth={0.5} opacity={0.15} />
          {paths.map((d, i) => (
            <polyline key={i} points={d} fill="none" stroke={glow} strokeWidth={0.8 + rng4() * 0.8} opacity={0.35 + rng4() * 0.3} />
          ))}
        </g>
      );
    }
    // Default: emission cloud (irregular blob)
    const blobs = Array.from({ length: 5 }, (_, i) => {
      const a = (i / 5) * 2 * Math.PI;
      const dr = r * (0.4 + rng() * 0.5);
      return { x: cx + Math.cos(a) * dr * 0.6, y: cy + Math.sin(a) * dr * 0.6, r: r * (0.3 + rng() * 0.45) };
    });
    return (
      <g opacity={0.75}>
        <defs>
          <radialGradient id={`nb${id}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={glow} stopOpacity={0.6} />
            <stop offset="50%" stopColor={color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={color} stopOpacity={0.0} />
          </radialGradient>
        </defs>
        <ellipse cx={cx} cy={cy} rx={r * 1.05} ry={r * 0.9} fill={`url(#nb${id})`} />
        {blobs.map((b, i) => (
          <circle key={i} cx={b.x} cy={b.y} r={b.r}
            fill={color} opacity={0.18 + rng() * 0.18} />
        ))}
      </g>
    );
  };

  return (
    <div style={{ flexShrink: 0 }}>
      <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 6 }}>
        SIMULAZIONE FOV — <span style={{ color: vis.color }}>{vis.label}</span>
      </div>
      <div style={{ position: "relative", width: IMG, height: IMG }}>
        <svg width={IMG} height={IMG} style={{ borderRadius: 8, border: "1px solid #1e3a5f", display: "block" }}>
          {/* Deep sky background with subtle vignette */}
          <defs>
            <radialGradient id="sky" cx="50%" cy="50%" r="70%">
              <stop offset="0%" stopColor="#0d1a2e" />
              <stop offset="100%" stopColor="#020609" />
            </radialGradient>
          </defs>
          <rect width={IMG} height={IMG} fill="url(#sky)" rx={7} />

          {/* Background stars */}
          {stars.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r} fill={s.h} opacity={s.op} />
          ))}

          {/* The deep sky object */}
          {renderObject()}

          {/* Object size circle (dashed) */}
          {objRpx > 4 && (
            <circle cx={cx} cy={cy} r={objRpx}
              fill="none" stroke="#fbbf24" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.45} />
          )}

          {/* FOV rectangle */}
          {fovRect && (
            <>
              <rect x={fovRect.x} y={fovRect.y} width={fovRect.w} height={fovRect.h}
                fill="rgba(74,222,128,0.04)" stroke="#4ade80" strokeWidth={1.5} opacity={0.92} rx={1} />
              {[
                [fovRect.x, fovRect.y, 1, 1],
                [fovRect.x + fovRect.w, fovRect.y, -1, 1],
                [fovRect.x, fovRect.y + fovRect.h, 1, -1],
                [fovRect.x + fovRect.w, fovRect.y + fovRect.h, -1, -1],
              ].map(([bx, by, dx, dy], i) => (
                <g key={i}>
                  <line x1={bx} y1={by} x2={bx + dx * 12} y2={by} stroke="#4ade80" strokeWidth={2.5} />
                  <line x1={bx} y1={by} x2={bx} y2={by + dy * 12} stroke="#4ade80" strokeWidth={2.5} />
                </g>
              ))}
              {fovData && (
                <>
                  <rect x={fovRect.x + fovRect.w / 2 - 40} y={fovRect.y - 16} width={80} height={13} rx={3} fill="rgba(0,0,0,0.75)" />
                  <text x={fovRect.x + fovRect.w / 2} y={fovRect.y - 6}
                    textAnchor="middle" fill="#4ade80" fontSize={9} fontWeight="bold">
                    {fovData.fovW.toFixed(1)}′ × {fovData.fovH.toFixed(1)}′
                  </text>
                </>
              )}
            </>
          )}

          {/* Crosshair */}
          <line x1={cx - 9} y1={cy} x2={cx + 9} y2={cy} stroke="#fff" strokeWidth={0.7} opacity={0.35} />
          <line x1={cx} y1={cy - 9} x2={cx} y2={cy + 9} stroke="#fff" strokeWidth={0.7} opacity={0.35} />

          {/* Scale bar */}
          <rect x={6} y={IMG - 22} width={scaleBarPx + 6} height={14} rx={2} fill="rgba(0,0,0,0.6)" />
          <line x1={9} y1={IMG - 15} x2={9 + scaleBarPx} y2={IMG - 15} stroke="#ccc" strokeWidth={1.5} opacity={0.8} />
          <line x1={9} y1={IMG - 18} x2={9} y2={IMG - 12} stroke="#ccc" strokeWidth={1} opacity={0.8} />
          <line x1={9 + scaleBarPx} y1={IMG - 18} x2={9 + scaleBarPx} y2={IMG - 12} stroke="#ccc" strokeWidth={1} opacity={0.8} />
          <text x={9 + scaleBarPx / 2} y={IMG - 9} textAnchor="middle" fill="#ccc" fontSize={8} opacity={0.8}>
            {scaleArcmin >= 1 ? `${scaleArcmin}′` : `${Math.round(scaleArcmin * 60)}″`}
          </text>

          {/* Compass */}
          <rect x={IMG - 30} y={3} width={27} height={13} rx={2} fill="rgba(0,0,0,0.6)" />
          <text x={IMG - 17} y={12} textAnchor="middle" fill="#aaa" fontSize={8} opacity={0.75}>N↑ E←</text>
        </svg>
      </div>

      <div style={{ fontSize: 9, color: "#334155", marginTop: 4, textAlign: "center" }}>
        <span style={{ color: "#4ade80" }}>■</span> FOV &nbsp;
        <span style={{ color: "#fbbf24" }}>◯</span> est. oggetto &nbsp;
        <span style={{ color: "#475569" }}>simulazione procedurale</span>
      </div>
    </div>
  );
}

// ─── Camera Database ──────────────────────────────────────────────────────────
const CAMERA_DB = [
  // ZWO ASI — Color
  { brand: "ZWO", model: "ASI120MC-S",    px: 3.75, w: 1280,  h: 960,   color: true,  sensor: "1/3\"",    mp: 1.2  },
  { brand: "ZWO", model: "ASI224MC",      px: 3.75, w: 1304,  h: 976,   color: true,  sensor: "1/3\"",    mp: 1.2  },
  { brand: "ZWO", model: "ASI290MC",      px: 2.9,  w: 1936,  h: 1096,  color: true,  sensor: "1/2.8\"",  mp: 2.1  },
  { brand: "ZWO", model: "ASI385MC",      px: 3.75, w: 1936,  h: 1096,  color: true,  sensor: "1/1.8\"",  mp: 2.1  },
  { brand: "ZWO", model: "ASI462MC",      px: 2.9,  w: 1936,  h: 1096,  color: true,  sensor: "1/2.8\"",  mp: 2.1  },
  { brand: "ZWO", model: "ASI485MC",      px: 2.9,  w: 3840,  h: 2160,  color: true,  sensor: "1/1.2\"",  mp: 8.3  },
  { brand: "ZWO", model: "ASI533MC Pro",  px: 3.76, w: 3008,  h: 3008,  color: true,  sensor: "1\"",      mp: 9.0  },
  { brand: "ZWO", model: "ASI585MC",      px: 2.9,  w: 4096,  h: 2160,  color: true,  sensor: "1/1.2\"",  mp: 8.9  },
  { brand: "ZWO", model: "ASI678MC",      px: 2.0,  w: 3840,  h: 2160,  color: true,  sensor: "1/1.8\"",  mp: 8.3  },
  { brand: "ZWO", model: "ASI294MC Pro",  px: 4.63, w: 4144,  h: 2822,  color: true,  sensor: "4/3\"",    mp: 11.7 },
  { brand: "ZWO", model: "ASI2600MC Pro", px: 3.76, w: 6248,  h: 4176,  color: true,  sensor: "APS-C",    mp: 26.1 },
  { brand: "ZWO", model: "ASI6200MC Pro", px: 3.76, w: 9576,  h: 6388,  color: true,  sensor: "FF",       mp: 61.2 },
  // ZWO ASI — Mono
  { brand: "ZWO", model: "ASI120MM-S",    px: 3.75, w: 1280,  h: 960,   color: false, sensor: "1/3\"",    mp: 1.2  },
  { brand: "ZWO", model: "ASI174MM",      px: 5.86, w: 1936,  h: 1216,  color: false, sensor: "1/1.2\"",  mp: 2.4  },
  { brand: "ZWO", model: "ASI183MM Pro",  px: 2.4,  w: 5496,  h: 3672,  color: false, sensor: "1\"",      mp: 20.2 },
  { brand: "ZWO", model: "ASI294MM Pro",  px: 4.63, w: 4144,  h: 2822,  color: false, sensor: "4/3\"",    mp: 11.7 },
  { brand: "ZWO", model: "ASI1600MM Pro", px: 3.8,  w: 4656,  h: 3520,  color: false, sensor: "4/3\"",    mp: 16.4 },
  { brand: "ZWO", model: "ASI2600MM Pro", px: 3.76, w: 6248,  h: 4176,  color: false, sensor: "APS-C",    mp: 26.1 },
  { brand: "ZWO", model: "ASI6200MM Pro", px: 3.76, w: 9576,  h: 6388,  color: false, sensor: "FF",       mp: 61.2 },
  // QHY — Color
  { brand: "QHY",  model: "QHY183C",      px: 2.4,  w: 5496,  h: 3672,  color: true,  sensor: "1\"",      mp: 20.2 },
  { brand: "QHY",  model: "QHY268C",      px: 3.76, w: 6280,  h: 4210,  color: true,  sensor: "APS-C",    mp: 26.4 },
  { brand: "QHY",  model: "QHY294C",      px: 4.63, w: 4164,  h: 2796,  color: true,  sensor: "4/3\"",    mp: 11.6 },
  { brand: "QHY",  model: "QHY533C",      px: 3.76, w: 3008,  h: 3008,  color: true,  sensor: "1\"",      mp: 9.0  },
  { brand: "QHY",  model: "QHY600C",      px: 3.76, w: 9576,  h: 6388,  color: true,  sensor: "FF",       mp: 61.2 },
  // QHY — Mono
  { brand: "QHY",  model: "QHY183M",      px: 2.4,  w: 5496,  h: 3672,  color: false, sensor: "1\"",      mp: 20.2 },
  { brand: "QHY",  model: "QHY268M",      px: 3.76, w: 6280,  h: 4210,  color: false, sensor: "APS-C",    mp: 26.4 },
  { brand: "QHY",  model: "QHY294M",      px: 4.63, w: 4164,  h: 2796,  color: false, sensor: "4/3\"",    mp: 11.6 },
  { brand: "QHY",  model: "QHY600M",      px: 3.76, w: 9576,  h: 6388,  color: false, sensor: "FF",       mp: 61.2 },
  // Player One — Color
  { brand: "Player One", model: "Neptune-C II",  px: 2.9,  w: 1920, h: 1080, color: true,  sensor: "1/2.8\"", mp: 2.1  },
  { brand: "Player One", model: "Uranus-C",      px: 3.76, w: 3096, h: 2080, color: true,  sensor: "4/3\"",   mp: 6.4  },
  { brand: "Player One", model: "Apollo-M Max",  px: 3.76, w: 6252, h: 4188, color: true,  sensor: "APS-C",   mp: 26.2 },
  { brand: "Player One", model: "Poseidon-C",    px: 3.76, w: 6252, h: 4188, color: true,  sensor: "APS-C",   mp: 26.2 },
  { brand: "Player One", model: "Ares-M Pro",    px: 3.76, w: 3096, h: 2080, color: false, sensor: "4/3\"",   mp: 6.4  },
  { brand: "Player One", model: "Saturn-M SQR",  px: 3.76, w: 3096, h: 3096, color: false, sensor: "4/3\"",   mp: 9.6  },
  // Atik
  { brand: "Atik",  model: "Atik 383L+",         px: 5.4,  w: 3354, h: 2529, color: false, sensor: "APS-C",   mp: 8.5  },
  { brand: "Atik",  model: "Atik 16200",          px: 6.0,  w: 4499, h: 3599, color: false, sensor: "FF",      mp: 16.2 },
  { brand: "Atik",  model: "Apx26",               px: 3.76, w: 6248, h: 4176, color: false, sensor: "APS-C",   mp: 26.1 },
  // Starlight Xpress
  { brand: "SX",    model: "Trius SX-694",        px: 4.54, w: 2750, h: 2200, color: false, sensor: "APS-C",   mp: 6.05 },
  { brand: "SX",    model: "Trius SX-814",        px: 5.6,  w: 3388, h: 2712, color: false, sensor: "APS-C",   mp: 9.2  },
  // Moravian
  { brand: "Moravian", model: "C3-61000 Pro",     px: 3.76, w: 9576, h: 6388, color: false, sensor: "FF",      mp: 61.2 },
  { brand: "Moravian", model: "C1-17000",         px: 4.54, w: 4096, h: 4096, color: false, sensor: "APS-H",   mp: 16.8 },
  // DSLR / Mirrorless
  { brand: "Canon", model: "EOS 2000D (modded)",  px: 3.72, w: 6024, h: 4016, color: true,  sensor: "APS-C",   mp: 24.1 },
  { brand: "Canon", model: "EOS Ra",              px: 4.36, w: 6720, h: 4480, color: true,  sensor: "FF",      mp: 30.3 },
  { brand: "Nikon", model: "D5300 (modded)",      px: 3.89, w: 6000, h: 4000, color: true,  sensor: "APS-C",   mp: 24.0 },
  { brand: "Sony",  model: "A7S III (astro)",     px: 3.76, w: 4240, h: 2832, color: true,  sensor: "FF",      mp: 12.1 },
  { brand: "Sony",  model: "A7R IV (astro)",      px: 3.76, w: 9504, h: 6336, color: true,  sensor: "FF",      mp: 61.0 },
];

const CAMERA_BRANDS = ["Tutti", ...Array.from(new Set(CAMERA_DB.map(c => c.brand)))];

// ─── Setup Tab Component ──────────────────────────────────────────────────────

function SetupTab({ settings, s, fieldStyle, fov, fovData, t }) {
  const [camSearch, setCamSearch] = useState("");
  const [camBrand, setCamBrand] = useState("all");
  const [camType, setCamType] = useState("tutti");

  const filteredCams = useMemo(() => CAMERA_DB.filter(c => {
    const q = camSearch.toLowerCase();
    const matchSearch = !q || c.model.toLowerCase().includes(q) || c.brand.toLowerCase().includes(q) || c.sensor.toLowerCase().includes(q);
    const matchBrand = camBrand === "all" || c.brand === camBrand;
    const matchType = camType === "tutti" || (camType === "color" ? c.color : !c.color);
    return matchSearch && matchBrand && matchType;
  }), [camSearch, camBrand, camType]);

  const selectCamera = useCallback((cam) => {
    s("camera", `${cam.brand} ${cam.model}`);
    s("pixelSize", cam.px);
    s("sensorW", cam.w);
    s("sensorH", cam.h);
    s("colorCamera", cam.color);
  }, [s]);

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ fontSize: 14, color: "#93c5fd", marginBottom: 20, letterSpacing: 1 }}>{t("setupTitle")}</div>

      {/* Camera picker */}
      <div style={{ background: "#080f1e", border: "1px solid #1e3a5f", borderRadius: 10, padding: 16, marginBottom: 24 }}>
        <div style={{ fontSize: 11, color: "#475569", letterSpacing: 1, marginBottom: 12 }}>
          {t("cameraCatalogTitle")}
          <span style={{ color: "#1e3a5f", marginLeft: 8 }}>({CAMERA_DB.length} {t("colModel").toLowerCase()})</span>
        </div>

        {/* Filter row */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <input placeholder={t("searchCamera")} value={camSearch} onChange={e => setCamSearch(e.target.value)}
            style={{ ...fieldStyle, flex: "1 1 140px", minWidth: 120 }} />
          <select value={camBrand} onChange={e => setCamBrand(e.target.value)} style={{ ...fieldStyle, flex: "0 0 130px" }}>
            <option value="all">{t("allBrands")}</option>
            {CAMERA_BRANDS.filter(b => b !== "Tutti").map(b => <option key={b}>{b}</option>)}
          </select>
          <select value={camType} onChange={e => setCamType(e.target.value)} style={{ ...fieldStyle, flex: "0 0 150px" }}>
            <option value="tutti">{t("colorAndMono")}</option>
            <option value="color">{t("colorOnly")}</option>
            <option value="mono">{t("monoOnly")}</option>
          </select>
        </div>

        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 55px 110px 45px 46px", gap: 10,
          padding: "3px 10px", fontSize: 9, color: "#334155", letterSpacing: 1 }}>
          <div>{t("colModel")}</div><div>{t("colSensor")}</div><div>{t("colPixel")}</div>
          <div>{t("colResolution")}</div><div>{t("colMp")}</div><div>{t("colType")}</div>
        </div>

        {/* Camera list */}
        <div style={{ maxHeight: 280, overflowY: "auto", display: "grid", gap: 3 }}>
          {filteredCams.length === 0 && (
            <div style={{ fontSize: 12, color: "#334155", padding: 16, textAlign: "center" }}>{t("noCameraFound")}</div>
          )}
          {filteredCams.map((cam, i) => {
            const isSelected = settings.camera === `${cam.brand} ${cam.model}`;
            return (
              <div key={i} onClick={() => selectCamera(cam)} style={{
                display: "grid", gridTemplateColumns: "1fr 60px 55px 110px 45px 46px",
                gap: 10, alignItems: "center", padding: "6px 10px", borderRadius: 6, cursor: "pointer",
                background: isSelected ? "#0d2a1a" : i % 2 === 0 ? "#060c18" : "transparent",
                border: `1px solid ${isSelected ? "#1a5c30" : "transparent"}`,
              }}>
                <div style={{ fontSize: 12, color: isSelected ? "#4ade80" : "#cbd5e1", fontWeight: isSelected ? "bold" : "normal" }}>
                  {isSelected && <span style={{ marginRight: 6 }}>✓</span>}{cam.brand} {cam.model}
                </div>
                <div style={{ fontSize: 10, color: "#64748b" }}>{cam.sensor}</div>
                <div style={{ fontSize: 10, color: "#64748b" }}>{cam.px} µm</div>
                <div style={{ fontSize: 10, color: "#475569" }}>{cam.w}×{cam.h}</div>
                <div style={{ fontSize: 10, color: "#475569" }}>{cam.mp}</div>
                <div style={{ fontSize: 9, padding: "1px 6px", borderRadius: 10, textAlign: "center",
                  background: cam.color ? "#0e2d3d" : "#1e1040",
                  color: cam.color ? "#48cae4" : "#c084fc",
                  border: `1px solid ${cam.color ? "#48cae433" : "#c084fc33"}`,
                }}>
                  {cam.color ? "OSC" : "Mono"}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 9, color: "#1e3a5f", marginTop: 6 }}>
          {t("cameraClickHint", filteredCams.length)}
        </div>
      </div>

      {/* Manual fields */}
      <div style={{ fontSize: 11, color: "#475569", letterSpacing: 1, marginBottom: 12 }}>{t("opticsTitle")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {[
          { labelKey: "focalLabel", key: "focal", type: "number", step: 1 },
          { labelKey: "apertureLabel", key: "aperture", type: "number", step: 1 },
          { labelKey: "cameraNameLabel", key: "camera", type: "text" },
          { labelKey: "pixelSizeLabel", key: "pixelSize", type: "number", step: 0.01 },
          { labelKey: "sensorWLabel", key: "sensorW", type: "number", step: 1 },
          { labelKey: "sensorHLabel", key: "sensorH", type: "number", step: 1 },
        ].map(f => (
          <div key={f.key}>
            <label style={{ fontSize: 11, color: "#64748b", display: "block", marginBottom: 4 }}>{t(f.labelKey)}</label>
            <input type={f.type} step={f.step} value={settings[f.key]}
              onChange={e => s(f.key, f.type === "number" ? +e.target.value : e.target.value)}
              style={fieldStyle} />
          </div>
        ))}
        <div>
          <label style={{ fontSize: 11, color: "#64748b", display: "block", marginBottom: 4 }}>{t("sensorTypeLabel")}</label>
          <select value={settings.colorCamera ? "color" : "mono"} onChange={e => s("colorCamera", e.target.value === "color")} style={fieldStyle}>
            <option value="color">{t("colorSensor")}</option>
            <option value="mono">{t("monoSensor")}</option>
          </select>
        </div>
      </div>

      {/* Computed info */}
      <div style={{ marginTop: 24, background: "#0a1628", borderRadius: 10, padding: 16, border: "1px solid #1e3a5f" }}>
        <div style={{ fontSize: 12, color: "#475569", marginBottom: 12, letterSpacing: 1 }}>{t("computedTitle")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12 }}>
          <div style={{ color: "#64748b" }}>{t("focalRatio")}:
            <span style={{ color: "#93c5fd", marginLeft: 8 }}>f/{settings.aperture ? (settings.focal / settings.aperture).toFixed(1) : "—"}</span>
          </div>
          <div style={{ color: "#64748b" }}>{t("imageScale")}:
            <span style={{ color: "#a78bfa", marginLeft: 8 }}>{fov ? `${fov}″/px` : "—"}</span>
          </div>
          <div style={{ color: "#64748b" }}>{t("fovW")}:
            <span style={{ color: "#4ade80", marginLeft: 8 }}>{fovData ? `${fovData.fovW.toFixed(1)}′ (${(fovData.fovW/60).toFixed(2)}°)` : "—"}</span>
          </div>
          <div style={{ color: "#64748b" }}>{t("fovH")}:
            <span style={{ color: "#4ade80", marginLeft: 8 }}>{fovData ? `${fovData.fovH.toFixed(1)}′ (${(fovData.fovH/60).toFixed(2)}°)` : "—"}</span>
          </div>
          <div style={{ color: "#64748b" }}>{t("sensor")}:
            <span style={{ color: settings.colorCamera ? "#48cae4" : "#c084fc", marginLeft: 8 }}>
              {settings.colorCamera ? t("colorSensor") : t("monoSensor")}
            </span>
          </div>
          <div style={{ color: "#64748b" }}>{t("camera")}:
            <span style={{ color: "#e2e8f0", marginLeft: 8 }}>{settings.camera}</span>
          </div>
        </div>
        {!settings.colorCamera && (
          <div style={{ marginTop: 12, fontSize: 11, color: "#e76f51", background: "#1a0f06", padding: 10, borderRadius: 6 }}>
            {t("monoWarning")}
          </div>
        )}
      </div>
    </div>
  );
}

function AltitudeCurve({ points, hasCustomHorizon }) {
  if (!points || points.length === 0) return null;

  const W = 340, H = 90;
  const padL = 28, padR = 6, padT = 6, padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Y range: -10° to max+5°, minimum 60°
  const maxAlt = Math.max(...points.map(p => p.alt));
  const yMax = Math.max(60, Math.ceil((maxAlt + 8) / 10) * 10);
  const yMin = -10;
  const yRange = yMax - yMin;

  const toX = (hour) => padL + ((hour - 19) / 13) * plotW;
  const toY = (alt) => padT + plotH - ((alt - yMin) / yRange) * plotH;

  // Build SVG path segments coloured by visibility
  // Split into contiguous visible / not-visible segments
  const segments = [];
  let cur = null;
  for (const p of points) {
    if (!cur || cur.visible !== p.visible) {
      if (cur) segments.push(cur);
      cur = { visible: p.visible, pts: [p] };
    } else {
      cur.pts.push(p);
    }
  }
  if (cur) segments.push(cur);

  const pathD = (pts) =>
    pts.map((p, i) =>
      `${i === 0 ? "M" : "L"}${toX(p.hour).toFixed(1)},${toY(p.alt).toFixed(1)}`
    ).join(" ");

  // Horizon line (custom) – draw the actual horizon alt for each point
  const horizonPath = hasCustomHorizon
    ? points.map((p, i) =>
        `${i === 0 ? "M" : "L"}${toX(p.hour).toFixed(1)},${toY(p.horizAlt).toFixed(1)}`
      ).join(" ")
    : null;

  // Zero line Y
  const y0 = toY(0);

  // Hour labels 20,22,00,02,04,06
  const hourLabels = [20, 22, 0, 2, 4, 6];

  // Alt grid lines
  const altGrid = [];
  for (let a = 0; a <= yMax; a += 20) altGrid.push(a);

  // Find night region (roughly 21:00–05:00)
  const nightX1 = toX(21), nightX2 = toX(30); // 30 = 06:00 next day

  return (
    <svg width={W} height={H} style={{ display: "block", overflow: "visible" }}>
      {/* Night background */}
      <rect x={nightX1} y={padT} width={Math.max(0, nightX2 - nightX1)} height={plotH}
        fill="#0a1628" rx={2} />
      {/* Twilight shading */}
      <rect x={toX(19)} y={padT} width={nightX1 - toX(19)} height={plotH}
        fill="#1a1030" rx={2} />
      <rect x={nightX2} y={padT} width={toX(32) - nightX2} height={plotH}
        fill="#1a1030" rx={2} />

      {/* Alt grid */}
      {altGrid.map(a => (
        <g key={a}>
          <line x1={padL} y1={toY(a)} x2={W - padR} y2={toY(a)}
            stroke="#1e293b" strokeWidth={1} />
          <text x={padL - 3} y={toY(a) + 3} textAnchor="end"
            fill="#334155" fontSize={8}>{a}°</text>
        </g>
      ))}

      {/* Zero line */}
      <line x1={padL} y1={y0} x2={W - padR} y2={y0}
        stroke="#334155" strokeWidth={1} strokeDasharray="3,2" />

      {/* Custom horizon line */}
      {horizonPath && (
        <path d={horizonPath} fill="none" stroke="#e76f51"
          strokeWidth={1} strokeDasharray="4,3" opacity={0.7} />
      )}

      {/* Altitude curve segments */}
      {segments.map((seg, idx) => (
        <path key={idx} d={pathD(seg.pts)} fill="none"
          stroke={seg.visible ? "#4ade80" : "#475569"}
          strokeWidth={seg.visible ? 2 : 1.2}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={seg.visible ? 1 : 0.5} />
      ))}

      {/* Visible fill area above horizon */}
      {segments.filter(s => s.visible).map((seg, idx) => {
        if (seg.pts.length < 2) return null;
        const area = [
          ...seg.pts.map((p, i) =>
            `${i === 0 ? "M" : "L"}${toX(p.hour).toFixed(1)},${toY(p.alt).toFixed(1)}`
          ),
          ...seg.pts.slice().reverse().map((p) =>
            `L${toX(p.hour).toFixed(1)},${toY(Math.max(p.horizAlt, yMin)).toFixed(1)}`
          ),
          "Z"
        ].join(" ");
        return <path key={idx} d={area} fill="#4ade80" opacity={0.08} />;
      })}

      {/* Hour axis labels */}
      {hourLabels.map(h => {
        const displayH = h < 19 ? h + 24 : h; // convert to fractional hour after 19:00
        const xPos = toX(h < 19 ? h + 24 : h);
        if (xPos < padL || xPos > W - padR) return null;
        return (
          <g key={h}>
            <line x1={xPos} y1={padT + plotH} x2={xPos} y2={padT + plotH + 3}
              stroke="#334155" strokeWidth={1} />
            <text x={xPos} y={H - 4} textAnchor="middle"
              fill="#475569" fontSize={8}>
              {String(h).padStart(2, "0")}:00
            </text>
          </g>
        );
      })}

      {/* Legend */}
      {hasCustomHorizon && (
        <g>
          <line x1={padL} y1={padT + 4} x2={padL + 14} y2={padT + 4}
            stroke="#e76f51" strokeWidth={1} strokeDasharray="4,3" opacity={0.7} />
          <text x={padL + 17} y={padT + 7} fill="#e76f51" fontSize={7} opacity={0.7}>orizzonte</text>
        </g>
      )}
    </svg>
  );
}



const MODES = { narrowband: { label: "Banda Stretta", color: "#e76f51", icon: "◉" }, broadband: { label: "Banda Larga", color: "#48cae4", icon: "◎" } };

function ScoreBadge({ score }) {
  const color = score >= 75 ? "#4ade80" : score >= 45 ? "#facc15" : "#f87171";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <svg width={36} height={36} viewBox="0 0 36 36">
        <circle cx={18} cy={18} r={15} fill="none" stroke="#1e293b" strokeWidth={4} />
        <circle cx={18} cy={18} r={15} fill="none" stroke={color} strokeWidth={4}
          strokeDasharray={`${(score / 100) * 94.2} 94.2`}
          strokeLinecap="round"
          transform="rotate(-90 18 18)" />
        <text x={18} y={22} textAnchor="middle" fill={color} fontSize={10} fontWeight="bold">{score}</text>
      </svg>
    </div>
  );
}

function HorizonPreview({ profile, t }) {
  if (!profile) return null;
  const w = 280, h = 80;
  const pts = profile.map((alt, az) => {
    const x = (az / 359) * w;
    const y = h - (alt / 30) * h;
    return `${x},${Math.max(0, y)}`;
  }).join(" ");
  const label = t ? t("horizonPreviewLabel") : "Profilo orizzonte (N→E→S→W→N)";
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>{label}</div>
      <svg width={w} height={h} style={{ background: "#0f172a", borderRadius: 6, display: "block" }}>
        <polyline points={pts} fill="none" stroke="#e76f51" strokeWidth={1.5} />
        {[0, 10, 20, 30].map(alt => (
          <line key={alt} x1={0} y1={h - (alt / 30) * h} x2={w} y2={h - (alt / 30) * h}
            stroke="#1e293b" strokeWidth={1} />
        ))}
        {["N", "E", "S", "W"].map((d, i) => (
          <text key={d} x={(i * 90 / 360) * w + 2} y={h - 2} fill="#475569" fontSize={9}>{d}</text>
        ))}
      </svg>
    </div>
  );
}

// ─── i18n ─────────────────────────────────────────────────────────────────────

const TRANSLATIONS = {
  it: {
    // Header
    appSubtitle: "PIANIFICATORE ASTROFOTOGRAFICO MENSILE",
    tabObjects: "Oggetti",
    tabSetup: "Setup",
    tabHorizon: "Orizzonte",
    // Sidebar – objects
    period: "PERIODO",
    coordinates: "COORDINATE",
    latLabel: "Latitudine °N",
    lonLabel: "Longitudine °E",
    filterTech: "FILTRO TECNICA",
    filterAll: "Tutti",
    filterNarrow: "Banda Stretta",
    filterBroad: "Banda Larga",
    summary: "RIEPILOGO",
    catalogueLoading: "⏳ caricamento…",
    catalogueOk: (n) => `✓ ${n.toLocaleString()} oggetti`,
    catalogueFallback: (n) => `⚠ fallback (${n})`,
    filtered: "Filtrati",
    excellent: "Ottimi (≥75)",
    good: "Buoni (45–74)",
    horizonActive: "✓ Orizzonte custom attivo",
    scale: "Scala",
    fovLabel: "FOV",
    // Sidebar – setup
    currentSetup: "SETUP CORRENTE",
    camera: "Camera",
    pixelSize: "Pixel size",
    sensor: "Sensore",
    resolution: "Risoluzione",
    focal: "Focale",
    aperture: "Apertura",
    // Sidebar – horizon
    horizonActiveTitle: "ORIZZONTE ATTIVO",
    profileLoaded: "✓ Profilo caricato",
    fileLabel: "File",
    points: "Punti",
    avgAlt: "Alt. media",
    maxAlt: "Alt. max",
    removeProfile: "✕ Rimuovi profilo",
    noProfile: "Nessun profilo caricato.",
    flatHorizon: "L'orizzonte è considerato piatto a 0°.",
    csvFormat: "FORMATO CSV ATTESO",
    // Results tab
    searchPlaceholder: "🔍  Cerca per nome, NGC, IC, Messier, costellazione…",
    allTypes: "Tutti i tipi",
    magMax: "Mag max (es. 12)",
    sizeMax: "Dim. max ′ (es. 30)",
    reset: "✕ Reset",
    openNGCOk: (n, p, tot) => `✓ OpenNGC+ext · ${n.toLocaleString()} oggetti filtrati · pagina ${p}/${tot}`,
    openNGCLoading: "⏳ Caricamento catalogo…",
    openNGCError: (n) => `⚠ Catalogo fallback (${n} oggetti) — verifica connessione`,
    expandAll: "▼ Apri tutte",
    collapseAll: "▲ Chiudi tutte",
    noResults: "Nessun oggetto trovato con questi filtri.",
    catalogueLoading2: "⏳ Caricamento catalogo in corso…",
    objectsPerPage: (n) => `${n} oggetti/pag`,
    // Card fields
    maxAltCard: "Max",
    transit: "transito",
    visibleMin: "min visibile/notte",
    filters: "Filtri",
    // Altitude curve
    altCurveTitle: "CURVA DI ALTITUDINE",
    horizonCustomActive: "— orizzonte custom attivo",
    horizonFlat: "— orizzonte piatto (0°)",
    visibleLegend: "visibile (sopra orizzonte +5°)",
    notVisibleLegend: "non visibile / sotto orizzonte",
    horizonLineLegend: "profilo orizzonte personalizzato",
    visibleMinLegend: "min visibile",
    // Setup tab
    setupTitle: "CONFIGURAZIONE SETUP",
    cameraCatalogTitle: "SELEZIONA CAMERA DAL CATALOGO",
    searchCamera: "Cerca modello…",
    allBrands: "Tutti",
    colorAndMono: "Colori + Mono",
    colorOnly: "Solo Colori (OSC)",
    monoOnly: "Solo Mono",
    colModel: "MODELLO", colSensor: "SENSORE", colPixel: "PIXEL",
    colResolution: "RISOLUZIONE", colMp: "MP", colType: "TIPO",
    noCameraFound: "Nessuna camera trovata",
    cameraClickHint: (n) => `${n} risultati · clicca per compilare i parametri automaticamente`,
    opticsTitle: "PARAMETRI OTTICI / PERSONALIZZATI",
    focalLabel: "Focale telescopio (mm)",
    apertureLabel: "Apertura telescopio (mm)",
    cameraNameLabel: "Nome camera",
    pixelSizeLabel: "Dimensione pixel (µm)",
    sensorWLabel: "Sensore larghezza (pixel)",
    sensorHLabel: "Sensore altezza (pixel)",
    sensorTypeLabel: "Tipo sensore",
    colorSensor: "Colori (OSC/One-Shot)",
    monoSensor: "Monocromatica (Mono)",
    computedTitle: "PARAMETRI CALCOLATI",
    focalRatio: "Rapporto focale (f/)",
    imageScale: "Scala immagine",
    fovW: "Campo inquadrato (W)",
    fovH: "Campo inquadrato (H)",
    monoWarning: "⚠ Camera mono: la colonna \"Filtri\" indica i filtri necessari per ciascun oggetto. Pianifica le sessioni per filtro.",
    // Horizon tab
    horizonTitle: "PROFILO ORIZZONTE PERSONALIZZATO",
    horizonDesc: (sep) => `Carica un file CSV con due colonne: azimut (0–359) e altezza ostacolo in gradi. Separatori accettati: virgola, punto e virgola, spazio, tab.`,
    horizonExample: "→ Nord, ostacolo a 2.5°",
    dropzone: "Clicca o trascina il file CSV del profilo orizzonte",
    noProfileWarning: "Senza profilo personalizzato, il calcolo usa un orizzonte piatto a 0°. Puoi misurare il tuo orizzonte con applicazioni come Stellarium, Cartes du Ciel, oppure con fotometria panoramica.",
    uniformAlt: "Oppure inserisci manualmente (altezza uniforme)",
    uniformAltLabel: "° altezza uniforme su tutto l'orizzonte",
    horizonPreviewLabel: "Profilo orizzonte (N→E→S→W→N)",
    objFiltered: "oggetti filtrati",
    page: "pagina",
  },

  en: {
    appSubtitle: "MONTHLY ASTROPHOTOGRAPHY PLANNER",
    tabObjects: "Objects",
    tabSetup: "Setup",
    tabHorizon: "Horizon",
    period: "PERIOD",
    coordinates: "COORDINATES",
    latLabel: "Latitude °N",
    lonLabel: "Longitude °E",
    filterTech: "IMAGING MODE",
    filterAll: "All",
    filterNarrow: "Narrowband",
    filterBroad: "Broadband",
    summary: "SUMMARY",
    catalogueLoading: "⏳ loading…",
    catalogueOk: (n) => `✓ ${n.toLocaleString()} objects`,
    catalogueFallback: (n) => `⚠ fallback (${n})`,
    filtered: "Filtered",
    excellent: "Excellent (≥75)",
    good: "Good (45–74)",
    horizonActive: "✓ Custom horizon active",
    scale: "Scale",
    fovLabel: "FOV",
    currentSetup: "CURRENT SETUP",
    camera: "Camera",
    pixelSize: "Pixel size",
    sensor: "Sensor",
    resolution: "Resolution",
    focal: "Focal length",
    aperture: "Aperture",
    horizonActiveTitle: "ACTIVE HORIZON",
    profileLoaded: "✓ Profile loaded",
    fileLabel: "File",
    points: "Points",
    avgAlt: "Avg alt",
    maxAlt: "Max alt",
    removeProfile: "✕ Remove profile",
    noProfile: "No profile loaded.",
    flatHorizon: "Horizon is considered flat at 0°.",
    csvFormat: "EXPECTED CSV FORMAT",
    searchPlaceholder: "🔍  Search by name, NGC, IC, Messier, constellation…",
    allTypes: "All types",
    magMax: "Max mag (e.g. 12)",
    sizeMax: "Max size ′ (e.g. 30)",
    reset: "✕ Reset",
    openNGCOk: (n, p, tot) => `✓ OpenNGC+ext · ${n.toLocaleString()} objects filtered · page ${p}/${tot}`,
    openNGCLoading: "⏳ Loading catalogue…",
    openNGCError: (n) => `⚠ Fallback catalogue (${n} objects) — check connection`,
    expandAll: "▼ Expand all",
    collapseAll: "▲ Collapse all",
    noResults: "No objects found with these filters.",
    catalogueLoading2: "⏳ Loading catalogue…",
    objectsPerPage: (n) => `${n} obj/page`,
    maxAltCard: "Max",
    transit: "transit",
    visibleMin: "min visible/night",
    filters: "Filters",
    altCurveTitle: "ALTITUDE CURVE",
    horizonCustomActive: "— custom horizon active",
    horizonFlat: "— flat horizon (0°)",
    visibleLegend: "visible (above horizon +5°)",
    notVisibleLegend: "not visible / below horizon",
    horizonLineLegend: "custom horizon profile",
    visibleMinLegend: "min visible",
    setupTitle: "SETUP CONFIGURATION",
    cameraCatalogTitle: "SELECT CAMERA FROM CATALOGUE",
    searchCamera: "Search model…",
    allBrands: "All",
    colorAndMono: "Color + Mono",
    colorOnly: "Color only (OSC)",
    monoOnly: "Mono only",
    colModel: "MODEL", colSensor: "SENSOR", colPixel: "PIXEL",
    colResolution: "RESOLUTION", colMp: "MP", colType: "TYPE",
    noCameraFound: "No camera found",
    cameraClickHint: (n) => `${n} results · click to auto-fill parameters`,
    opticsTitle: "OPTICS / CUSTOM PARAMETERS",
    focalLabel: "Telescope focal length (mm)",
    apertureLabel: "Telescope aperture (mm)",
    cameraNameLabel: "Camera name",
    pixelSizeLabel: "Pixel size (µm)",
    sensorWLabel: "Sensor width (pixels)",
    sensorHLabel: "Sensor height (pixels)",
    sensorTypeLabel: "Sensor type",
    colorSensor: "Color (OSC/One-Shot)",
    monoSensor: "Monochrome (Mono)",
    computedTitle: "COMPUTED PARAMETERS",
    focalRatio: "Focal ratio (f/)",
    imageScale: "Image scale",
    fovW: "Field of view (W)",
    fovH: "Field of view (H)",
    monoWarning: "⚠ Mono camera: the \"Filters\" column shows which filters are needed per object. Plan sessions by filter.",
    horizonTitle: "CUSTOM HORIZON PROFILE",
    horizonDesc: () => `Upload a CSV file with two columns: azimuth (0–359) and obstacle height in degrees. Accepted separators: comma, semicolon, space, tab.`,
    horizonExample: "→ North, obstacle at 2.5°",
    dropzone: "Click or drag the horizon profile CSV file",
    noProfileWarning: "Without a custom profile, calculation uses a flat horizon at 0°. You can measure your horizon with apps like Stellarium, Cartes du Ciel, or panoramic photography.",
    uniformAlt: "Or enter manually (uniform height)",
    uniformAltLabel: "° uniform altitude over the whole horizon",
    horizonPreviewLabel: "Horizon profile (N→E→S→W→N)",
    objFiltered: "objects filtered",
    page: "page",
  },
};

const MONTHS_IT = ["Gennaio","Febbraio","Marzo","Aprile","Maggio","Giugno","Luglio","Agosto","Settembre","Ottobre","Novembre","Dicembre"];
const MONTHS_EN = ["January","February","March","April","May","June","July","August","September","October","November","December"];


export default function AstroPlanner() {
  const now = new Date();
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem("astroplan-lang") || "it"; } catch { return "it"; }
  });
  const t = (key, ...args) => {
    const v = TRANSLATIONS[lang][key];
    return typeof v === "function" ? v(...args) : (v ?? key);
  };
  const MONTHS = lang === "it" ? MONTHS_IT : MONTHS_EN;
  const toggleLang = () => {
    const next = lang === "it" ? "en" : "it";
    setLang(next);
    try { localStorage.setItem("astroplan-lang", next); } catch {}
  };
  const [settings, setSettings] = useState({
    lat: 45.5,
    lon: 10.2,
    focal: 600,
    aperture: 102,
    camera: "ASI294MC Pro",
    colorCamera: true,
    pixelSize: 4.63,
    sensorW: 4144,   // pixels width
    sensorH: 2822,   // pixels height
    year: now.getFullYear(),
    month: now.getMonth(),
  });
  const [horizonProfile, setHorizonProfile] = useState(null);
  const [horizonName, setHorizonName] = useState("");
  const [filter, setFilter] = useState("all");
  const [tab, setTab] = useState("results");

  // OpenNGC catalogue state
  const [catalogue, setCatalogue] = useState(CATALOGUE_FALLBACK);
  const [catalogueStatus, setCatalogueStatus] = useState("idle"); // idle | loading | ok | error
  const [catalogueCount, setCatalogueCount] = useState(0);

  // Search / filter / pagination for results tab
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [minMag, setMinMag] = useState("");
  const [maxSize, setMaxSize] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Fetch all catalogues in parallel on first load
  // All CSV files must be placed in the /public folder of the Vite project
  useEffect(() => {
    setCatalogueStatus("loading");
    const base = import.meta.env.BASE_URL;
    const fetches = [
      { url: base + "NGC.csv",       parser: parseOpenNGC,   label: "NGC" },
      { url: base + "Sharpless.csv", parser: parseSharpless, label: "Sh2" },
      { url: base + "Barnard.csv",   parser: parseBarnard,   label: "B"   },
      { url: base + "AbellPN.csv",   parser: parseAbellPN,   label: "Abell PN" },
      { url: base + "CollMel.csv",   parser: parseCollMel,   label: "Coll/Mel" },
    ];

    Promise.allSettled(fetches.map(f =>
      fetch(f.url)
        .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(text => ({ label: f.label, objects: f.parser(text) }))
    )).then(results => {
      const all = [];
      let loaded = 0;
      results.forEach(r => {
        if (r.status === "fulfilled" && r.value.objects.length > 0) {
          all.push(...r.value.objects);
          loaded++;
        }
      });
      if (all.length > 100) {
        setCatalogue(all);
        setCatalogueCount(all.length);
        setCatalogueStatus("ok");
      } else {
        setCatalogueStatus("error");
        setCatalogueCount(CATALOGUE_FALLBACK.length);
      }
    });
  }, []);

  const date = useMemo(() => new Date(settings.year, settings.month, 15), [settings.year, settings.month]);

  // Unique type labels for filter dropdown
  const typeLabels = useMemo(() => {
    const s = new Set(catalogue.map(o => o.type));
    return ["all", ...Array.from(s).sort()];
  }, [catalogue]);

  // Filtered catalogue (before scoring — cheap pass)
  const filteredCatalogue = useMemo(() => {
    const q = search.toLowerCase().trim();
    const maxMag = minMag !== "" ? parseFloat(minMag) : 99;
    const minSize = maxSize !== "" ? 0 : 0; // unused placeholder
    const maxSizePx = maxSize !== "" ? parseFloat(maxSize) : 99999;
    return catalogue.filter(o => {
      if (filter !== "all" && o.mode !== filter) return false;
      if (typeFilter !== "all" && o.type !== typeFilter) return false;
      if (o.mag > maxMag) return false;
      if (maxSize !== "" && o.size > maxSizePx) return false;
      if (q) {
        const hay = `${o.id} ${o.name} ${o.catalogName || ""} ${o.mId || ""} ${o.constellation || ""} ${o.type}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [catalogue, filter, typeFilter, search, minMag, maxSize]);

  // Score only the visible page + a bit ahead for perf (score is expensive)
  const scoredPage = useMemo(() => {
    // First sort by magnitude (brightest first) so scoring the first page is useful
    const sorted = [...filteredCatalogue].sort((a, b) => a.mag - b.mag);
    const start = page * PAGE_SIZE;
    const slice = sorted.slice(start, start + PAGE_SIZE);
    return slice
      .map(obj => scoreObject(obj, settings.lat, settings.lon, date, horizonProfile))
      .sort((a, b) => b.score - a.score);
  }, [filteredCatalogue, page, settings.lat, settings.lon, date, horizonProfile]);

  const totalPages = Math.ceil(filteredCatalogue.length / PAGE_SIZE);

  const handleHorizonFile = useCallback((e) => {
    const file = e.target.files[0];
    if (!file) return;
    setHorizonName(file.name);
    const reader = new FileReader();
    reader.onload = ev => {
      const profile = parseHorizonCSV(ev.target.result);
      setHorizonProfile(profile);
    };
    reader.readAsText(file);
  }, []);

  const fovData = useMemo(() => {
    if (!settings.focal || !settings.pixelSize) return null;
    const arcsecPx = (settings.pixelSize / settings.focal) * 206.265;
    const fovW = (arcsecPx * settings.sensorW) / 60; // arcmin
    const fovH = (arcsecPx * settings.sensorH) / 60; // arcmin
    return { arcsecPx, fovW, fovH };
  }, [settings.focal, settings.pixelSize, settings.sensorW, settings.sensorH]);

  const fov = fovData ? fovData.arcsecPx.toFixed(2) : null;

  const [expanded, setExpanded] = useState({});
  const toggleExpand = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  const s = (k, v) => setSettings(prev => ({ ...prev, [k]: v }));

  // Force full-viewport layout on the host document
  useEffect(() => {
    const style = document.createElement("style");
    style.id = "astroplan-global";
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { width: 100%; height: 100%; overflow-x: hidden; background: #060c18; }
      #root, [data-reactroot] { width: 100%; min-height: 100vh; display: block; }
    `;
    document.head.appendChild(style);
    return () => { const el = document.getElementById("astroplan-global"); if (el) el.remove(); };
  }, []);

  const fieldStyle = {
    background: "#0f172a",
    border: "1px solid #1e3a5f",
    borderRadius: 6,
    color: "#e2e8f0",
    padding: "6px 10px",
    fontSize: 13,
    width: "100%",
    boxSizing: "border-box",
  };

  return (
    <div style={{
      minHeight: "100vh",
      width: "100%",
      background: "#060c18",
      color: "#e2e8f0",
      fontFamily: "'Courier New', monospace",
      padding: 0,
      boxSizing: "border-box",
    }}>
      {/* Header */}
      <div style={{
        background: "linear-gradient(135deg, #0a1628 0%, #0d2040 100%)",
        borderBottom: "1px solid #1e3a5f",
        padding: "18px 24px",
        display: "flex",
        alignItems: "center",
        gap: 16,
      }}>
        <div style={{ fontSize: 28 }}>🔭</div>
        <div>
          <div style={{ fontSize: 20, fontWeight: "bold", letterSpacing: 2, color: "#93c5fd" }}>
            ASTRO<span style={{ color: "#e76f51" }}>PLAN</span>
          </div>
          <div style={{ fontSize: 11, color: "#475569", letterSpacing: 1 }}>
            {t("appSubtitle")}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {/* Language toggle */}
          <button onClick={toggleLang} style={{
            background: "transparent",
            border: "1px solid #1e3a5f",
            borderRadius: 6,
            color: "#64748b",
            padding: "6px 12px",
            cursor: "pointer",
            fontSize: 11,
            letterSpacing: 1,
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}>
            {lang === "it" ? "🇮🇹 IT" : "🇬🇧 EN"}
          </button>
          {["results", "setup", "horizon"].map(tabKey => (
            <button key={tabKey} onClick={() => setTab(tabKey)} style={{
              background: tab === tabKey ? "#1e3a5f" : "transparent",
              border: `1px solid ${tab === tabKey ? "#3b82f6" : "#1e3a5f"}`,
              borderRadius: 6,
              color: tab === tabKey ? "#93c5fd" : "#475569",
              padding: "6px 14px",
              cursor: "pointer",
              fontSize: 12,
              letterSpacing: 1,
              textTransform: "uppercase",
            }}>
              {tabKey === "results" ? t("tabObjects") : tabKey === "setup" ? t("tabSetup") : t("tabHorizon")}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 0, width: "100%", minHeight: "calc(100vh - 62px)" }}>
        {/* Sidebar – fixed width, does not grow */}
        <div style={{
          width: 240,
          minWidth: 240,
          maxWidth: 240,
          background: "#080f1e",
          borderRight: "1px solid #1e3a5f",
          padding: 16,
          minHeight: "calc(100vh - 62px)",
          flexShrink: 0,
          flexGrow: 0,
          display: "flex",
          flexDirection: "column",
          boxSizing: "border-box",
        }}>
          {/* ── Sidebar content: contextual per tab ── */}

          {tab === "results" && (<>
            {/* Month / Year */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 8 }}>{t("period")}</div>
              <select value={settings.month} onChange={e => s("month", +e.target.value)} style={fieldStyle}>
                {MONTHS.map((m, i) => <option key={i} value={i}>{m}</option>)}
              </select>
              <input type="number" value={settings.year} onChange={e => s("year", +e.target.value)}
                style={{ ...fieldStyle, marginTop: 6 }} min={2020} max={2040} />
            </div>

            {/* Coordinates */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 8 }}>{t("coordinates")}</div>
              <label style={{ fontSize: 11, color: "#64748b" }}>{t("latLabel")}</label>
              <input type="number" step="0.01" value={settings.lat} onChange={e => s("lat", +e.target.value)} style={fieldStyle} />
              <label style={{ fontSize: 11, color: "#64748b", marginTop: 6, display: "block" }}>{t("lonLabel")}</label>
              <input type="number" step="0.01" value={settings.lon} onChange={e => s("lon", +e.target.value)} style={fieldStyle} />
            </div>

            {/* Filter */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 8 }}>{t("filterTech")}</div>
              {["all", "narrowband", "broadband"].map(f => (
                <button key={f} onClick={() => { setFilter(f); setPage(0); }} style={{
                  display: "block", width: "100%",
                  background: filter === f ? "#1e3a5f" : "transparent",
                  border: `1px solid ${filter === f ? "#3b82f6" : "#1e3a5f"}`,
                  borderRadius: 5,
                  color: filter === f ? "#93c5fd" : "#475569",
                  padding: "5px 10px", cursor: "pointer", fontSize: 11, textAlign: "left", marginBottom: 4,
                }}>
                  {f === "all" ? t("filterAll") : f === "narrowband" ? `${MODES[f].icon} ${t("filterNarrow")}` : `${MODES[f].icon} ${t("filterBroad")}`}
                </button>
              ))}
            </div>

            {/* Quick stats */}
            <div style={{ background: "#0a1628", borderRadius: 8, padding: 12, border: "1px solid #1e3a5f" }}>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 8 }}>{t("summary")}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>
                <div>
                  <span style={{ marginLeft: 0, color: catalogueStatus === "ok" ? "#4ade80" : catalogueStatus === "loading" ? "#facc15" : "#f87171" }}>
                    {catalogueStatus === "loading" ? t("catalogueLoading") : catalogueStatus === "ok" ? t("catalogueOk", catalogueCount) : t("catalogueFallback", catalogueCount)}
                  </span>
                </div>
                <div style={{ marginTop: 4 }}>{t("filtered")}: <span style={{ color: "#93c5fd" }}>{filteredCatalogue.length.toLocaleString()}</span></div>
                <div>{t("excellent")}: <span style={{ color: "#4ade80" }}>{scoredPage.filter(r => r.score >= 75).length}</span></div>
                <div>{t("good")}: <span style={{ color: "#facc15" }}>{scoredPage.filter(r => r.score >= 45 && r.score < 75).length}</span></div>
                {horizonProfile && <div style={{ marginTop: 6, color: "#e76f51", fontSize: 10 }}>{t("horizonActive")}</div>}
                {fov && <div style={{ marginTop: 4, color: "#a78bfa", fontSize: 10 }}>{t("scale")}: {fov}″/px</div>}
                {fovData && <div style={{ color: "#4ade80", fontSize: 10 }}>{t("fovLabel")}: {fovData.fovW.toFixed(1)}′×{fovData.fovH.toFixed(1)}′</div>}
              </div>
            </div>
          </>)}

          {tab === "setup" && (<>
            <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 16 }}>{t("currentSetup")}</div>
            <div style={{ fontSize: 11, color: "#64748b", lineHeight: 2 }}>
              <div>{t("camera")}:<br /><span style={{ color: "#e2e8f0", fontSize: 12 }}>{settings.camera || "—"}</span></div>
              <div style={{ marginTop: 10 }}>{t("pixelSize")}:<br /><span style={{ color: "#a78bfa", fontSize: 12 }}>{settings.pixelSize ? `${settings.pixelSize} µm` : "—"}</span></div>
              <div style={{ marginTop: 10 }}>{t("sensor")}:<br /><span style={{ color: settings.colorCamera ? "#48cae4" : "#c084fc", fontSize: 12 }}>{settings.colorCamera ? t("colorSensor") : t("monoSensor")}</span></div>
              <div style={{ marginTop: 10 }}>{t("resolution")}:<br /><span style={{ color: "#64748b", fontSize: 12 }}>{settings.sensorW && settings.sensorH ? `${settings.sensorW}×${settings.sensorH}` : "—"}</span></div>
            </div>
            <div style={{ marginTop: 20, borderTop: "1px solid #1e293b", paddingTop: 16, fontSize: 11, color: "#64748b", lineHeight: 2 }}>
              <div>{t("focal")}:<br /><span style={{ color: "#93c5fd", fontSize: 12 }}>{settings.focal ? `${settings.focal} mm` : "—"}</span></div>
              <div style={{ marginTop: 10 }}>{t("aperture")}:<br /><span style={{ color: "#93c5fd", fontSize: 12 }}>{settings.aperture ? `f/${(settings.focal/settings.aperture).toFixed(1)}` : "—"}</span></div>
              {fov && <div style={{ marginTop: 10 }}>{t("scale")}:<br /><span style={{ color: "#a78bfa", fontSize: 12 }}>{fov}″/px</span></div>}
              {fovData && <div style={{ marginTop: 10 }}>{t("fovLabel")}:<br /><span style={{ color: "#4ade80", fontSize: 12 }}>{fovData.fovW.toFixed(1)}′×{fovData.fovH.toFixed(1)}′</span></div>}
            </div>
          </>)}

          {tab === "horizon" && (<>
            <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 16 }}>{t("horizonActiveTitle")}</div>
            {horizonProfile ? (<>
              <div style={{ fontSize: 11, color: "#4ade80", marginBottom: 10 }}>{t("profileLoaded")}</div>
              <div style={{ fontSize: 11, color: "#64748b" }}>{t("fileLabel")}: <span style={{ color: "#e2e8f0" }}>{horizonName}</span></div>
              <div style={{ marginTop: 12, fontSize: 11, color: "#64748b" }}>
                {t("points")}: <span style={{ color: "#93c5fd" }}>{horizonProfile.filter(v => v > 0).length} az.</span><br />
                {t("avgAlt")}: <span style={{ color: "#e76f51" }}>{(horizonProfile.reduce((a, b) => a + b, 0) / 360).toFixed(1)}°</span><br />
                {t("maxAlt")}: <span style={{ color: "#f87171" }}>{Math.max(...horizonProfile).toFixed(1)}°</span>
              </div>
              <button onClick={() => { setHorizonProfile(null); setHorizonName(""); }}
                style={{ marginTop: 16, background: "#1a0a06", border: "1px solid #e76f5155", borderRadius: 6, color: "#e76f51", fontSize: 11, padding: "6px 10px", cursor: "pointer", width: "100%" }}>
                {t("removeProfile")}
              </button>
            </>) : (
              <div style={{ fontSize: 11, color: "#334155", lineHeight: 1.8 }}>
                {t("noProfile")}<br />
                <span style={{ color: "#475569" }}>{t("flatHorizon")}</span>
              </div>
            )}

            <div style={{ marginTop: 24, borderTop: "1px solid #1e293b", paddingTop: 16, fontSize: 10, color: "#334155", lineHeight: 1.9 }}>
              <div style={{ color: "#475569", marginBottom: 6 }}>{t("csvFormat")}</div>
              <code style={{ color: "#64748b", fontSize: 9 }}>azimut;altezza<br />0;5<br />45;12<br />90;8<br />…</code>
            </div>
          </>)}

          {/* Copyright – always visible at bottom */}
          <div style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid #1e293b", lineHeight: 1.8 }}>
            <div style={{ fontSize: 9, color: "#334155", letterSpacing: 0.5 }}>© Marco Manenti</div>
            <div style={{ fontSize: 10, color: "#e76f51", fontWeight: "bold", letterSpacing: 1.5 }}>Astro Myrddin</div>
            <div style={{ fontSize: 9, color: "#1e3a5f", letterSpacing: 1 }}>v0.1</div>
          </div>
        </div>

        {/* Main content – fills remaining width */}
        <div style={{ flex: 1, minWidth: 0, padding: 20, overflow: "auto" }}>

          {/* ── Tab: Results ── */}
          {tab === "results" && (
            <div>
              {/* Search + filter bar */}
              <div style={{ background: "#080f1e", border: "1px solid #1e3a5f", borderRadius: 10, padding: 12, marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <input
                  placeholder={t("searchPlaceholder")}
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(0); }}
                  style={{ ...fieldStyle, flex: "2 1 220px", background: "#060c18" }}
                />
                <select value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setPage(0); }}
                  style={{ ...fieldStyle, flex: "1 1 160px", background: "#060c18" }}>
                  <option value="all">{t("allTypes")}</option>
                  {typeLabels.filter(tl => tl !== "all").map(tl => <option key={tl} value={tl}>{tl}</option>)}
                </select>
                <input type="number" placeholder={t("magMax")} value={minMag}
                  onChange={e => { setMinMag(e.target.value); setPage(0); }}
                  style={{ ...fieldStyle, flex: "0 1 140px", background: "#060c18" }}
                />
                <input type="number" placeholder={t("sizeMax")} value={maxSize}
                  onChange={e => { setMaxSize(e.target.value); setPage(0); }}
                  style={{ ...fieldStyle, flex: "0 1 140px", background: "#060c18" }}
                />
                {(search || typeFilter !== "all" || minMag || maxSize) && (
                  <button onClick={() => { setSearch(""); setTypeFilter("all"); setMinMag(""); setMaxSize(""); setPage(0); }}
                    style={{ background: "#1a0f06", border: "1px solid #e76f5155", borderRadius: 6, color: "#e76f51", fontSize: 11, padding: "6px 12px", cursor: "pointer" }}>
                    {t("reset")}
                  </button>
                )}
              </div>

              {/* Status bar */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontSize: 12, color: "#475569" }}>
                  {catalogueStatus === "loading"
                    ? <span style={{ color: "#facc15" }}>{t("openNGCLoading")}</span>
                    : catalogueStatus === "ok"
                      ? <span><span style={{ color: "#4ade80" }}>✓ OpenNGC+ext</span> · <span style={{ color: "#93c5fd" }}>{filteredCatalogue.length.toLocaleString()}</span> {t("objFiltered")} · {t("page")} {page + 1}/{totalPages || 1}</span>
                      : <span style={{ color: "#f87171" }}>{t("openNGCError", catalogueCount)}</span>
                  }
                  <span style={{ marginLeft: 12, color: "#334155" }}>{MONTHS[settings.month]} {settings.year} · {settings.lat}°N {settings.lon}°E</span>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button onClick={() => setExpanded(Object.fromEntries(scoredPage.map(o => [o.id, true])))}
                    style={{ background: "#0a1628", border: "1px solid #1e3a5f", borderRadius: 6, color: "#64748b", fontSize: 11, padding: "5px 12px", cursor: "pointer" }}>{t("expandAll")}</button>
                  <button onClick={() => setExpanded({})}
                    style={{ background: "#0a1628", border: "1px solid #1e3a5f", borderRadius: 6, color: "#64748b", fontSize: 11, padding: "5px 12px", cursor: "pointer" }}>{t("collapseAll")}</button>
                </div>
              </div>

              <div style={{ display: "grid", gap: 10 }}>
                {scoredPage.length === 0 && (
                  <div style={{ textAlign: "center", padding: 40, color: "#334155", fontSize: 14 }}>
                    {catalogueStatus === "loading" ? t("catalogueLoading2") : t("noResults")}
                  </div>
                )}
                {scoredPage.map(obj => {
                  // Aladin Lite URL: opens sky viewer centred on object with correct FOV
                  const fovDeg = fovData
                    ? Math.max(fovData.fovW, fovData.fovH) / 60 * 1.5
                    : Math.max(obj.size * 3, 20) / 60;
                  const aladinUrl = `https://aladin.cds.unistra.fr/AladinLite/?target=${encodeURIComponent(obj.id)}&fov=${fovDeg.toFixed(3)}&survey=CDS%2FP%2FDSS2%2Fcolor`;

                  return (
                  <div key={obj.id} style={{
                    background: "#080f1e",
                    border: `1px solid ${obj.score >= 75 ? "#1e4d3a" : obj.score >= 45 ? "#3d3a1a" : "#2d1a1a"}`,
                    borderRadius: 10,
                    overflow: "hidden",
                  }}>
                    {/* Card header row */}
                    <div style={{
                      padding: "12px 14px",
                      display: "grid",
                      gridTemplateColumns: "48px 1fr auto",
                      gap: 12,
                      alignItems: "center",
                      cursor: "pointer",
                    }} onClick={() => toggleExpand(obj.id)}>
                      <ScoreBadge score={obj.score} />
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                          <a
                            href={aladinUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            title="Apri in Aladin Lite (immagine DSS + FOV interattivo)"
                            style={{ fontWeight: "bold", fontSize: 15, color: "#93c5fd", textDecoration: "none", borderBottom: "1px dotted #3b82f6" }}
                          >{obj.name}</a>
                          <span style={{ fontSize: 11, color: "#475569" }}>{obj.id}</span>
                          <span style={{
                            fontSize: 10,
                            background: obj.mode === "narrowband" ? "#2d1810" : "#0e2d3d",
                            color: MODES[obj.mode].color,
                            padding: "2px 7px",
                            borderRadius: 20,
                            border: `1px solid ${MODES[obj.mode].color}33`,
                          }}>
                            {MODES[obj.mode].icon} {MODES[obj.mode].label}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>
                          {obj.type} · {obj.description}
                        </div>
                        <div style={{ display: "flex", gap: 16, fontSize: 11, flexWrap: "wrap" }}>
                          <span style={{ color: "#a78bfa" }}>⏱ {obj.expHours}</span>
                          <span style={{ color: "#67e8f9" }}>▲ {t("maxAltCard")} {obj.maxAlt}°</span>
                          <span style={{ color: "#86efac" }}>🕐 {t("transit")} ~{obj.transit}</span>
                          <span style={{ color: "#fcd34d" }}>🌙 {obj.mins} {t("visibleMin")}</span>
                          <span style={{ color: "#94a3b8" }}>⌀ {obj.size}′ · mv {obj.mag}</span>
                          {obj.filters && <span style={{ color: MODES[obj.mode].color }}>🔬 {obj.filters}</span>}
                        </div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                        <div style={{ fontSize: 18, opacity: 0.15 }}>
                          {obj.type.includes("Galassia") ? "🌌" : obj.type.includes("Ammasso") ? "✨" : "💫"}
                        </div>
                        <div style={{ fontSize: 11, color: "#334155" }}>{expanded[obj.id] ? "▲" : "▼"}</div>
                      </div>
                    </div>

                    {/* Expandable altitude chart + FOV image */}
                    {expanded[obj.id] && (
                      <div style={{
                        borderTop: "1px solid #1e293b",
                        padding: "14px 14px 16px",
                        background: "#060c18",
                      }}>
                        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>

                          {/* FOV Image */}
                          <FovImage
                            ra={obj.ra}
                            dec={obj.dec}
                            objSize={obj.size}
                            fovData={fovData}
                            objName={obj.name}
                            objType={obj.type}
                          />

                          {/* Altitude chart + legend */}
                          <div style={{ flex: 1, minWidth: 300 }}>
                            <div style={{ fontSize: 10, color: "#475569", marginBottom: 6, letterSpacing: 1 }}>
                              {t("altCurveTitle")} &nbsp;19:00 → 08:00
                              {horizonProfile
                                ? <span style={{ color: "#e76f51", marginLeft: 8 }}>{t("horizonCustomActive")}</span>
                                : <span style={{ color: "#334155", marginLeft: 8 }}>{t("horizonFlat")}</span>
                              }
                            </div>
                            <AltitudeCurve
                              points={obj.nightCurve}
                              hasCustomHorizon={!!horizonProfile}
                            />
                            <div style={{ fontSize: 10, color: "#475569", lineHeight: 1.9, marginTop: 8 }}>
                              <div><span style={{ color: "#4ade80" }}>━</span> {t("visibleLegend")}</div>
                              <div><span style={{ color: "#475569" }}>━</span> {t("notVisibleLegend")}</div>
                              {horizonProfile && <div><span style={{ color: "#e76f51" }}>╌</span> {t("horizonLineLegend")}</div>}
                              <div style={{ marginTop: 6 }}>
                                <span style={{ color: "#67e8f9" }}>▲ Max: {obj.maxAlt}°</span>
                                &nbsp;·&nbsp;
                                <span style={{ color: "#fcd34d" }}>🌙 {obj.mins} {t("visibleMinLegend")}</span>
                                &nbsp;·&nbsp;
                                <span style={{ color: "#86efac" }}>🕐 {t("transit")} {obj.transit}</span>
                              </div>
                            </div>
                          </div>

                        </div>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div style={{ display: "flex", gap: 6, justifyContent: "center", alignItems: "center", marginTop: 20, flexWrap: "wrap" }}>
                  <button onClick={() => { setPage(0); setExpanded({}); }} disabled={page === 0}
                    style={{ background: "#080f1e", border: "1px solid #1e3a5f", borderRadius: 6, color: page === 0 ? "#1e3a5f" : "#64748b", fontSize: 11, padding: "5px 10px", cursor: page === 0 ? "default" : "pointer" }}>◀◀</button>
                  <button onClick={() => { setPage(p => Math.max(0, p - 1)); setExpanded({}); }} disabled={page === 0}
                    style={{ background: "#080f1e", border: "1px solid #1e3a5f", borderRadius: 6, color: page === 0 ? "#1e3a5f" : "#64748b", fontSize: 11, padding: "5px 10px", cursor: page === 0 ? "default" : "pointer" }}>◀</button>
                  {Array.from({ length: Math.min(9, totalPages) }, (_, i) => {
                    let p = totalPages <= 9 ? i : page < 5 ? i : page > totalPages - 5 ? totalPages - 9 + i : page - 4 + i;
                    return (
                      <button key={p} onClick={() => { setPage(p); setExpanded({}); }}
                        style={{ background: p === page ? "#1e3a5f" : "#080f1e", border: `1px solid ${p === page ? "#3b82f6" : "#1e3a5f"}`, borderRadius: 6, color: p === page ? "#93c5fd" : "#475569", fontSize: 11, padding: "5px 10px", cursor: "pointer", minWidth: 32 }}>
                        {p + 1}
                      </button>
                    );
                  })}
                  <button onClick={() => { setPage(p => Math.min(totalPages - 1, p + 1)); setExpanded({}); }} disabled={page >= totalPages - 1}
                    style={{ background: "#080f1e", border: "1px solid #1e3a5f", borderRadius: 6, color: page >= totalPages - 1 ? "#1e3a5f" : "#64748b", fontSize: 11, padding: "5px 10px", cursor: page >= totalPages - 1 ? "default" : "pointer" }}>▶</button>
                  <button onClick={() => { setPage(totalPages - 1); setExpanded({}); }} disabled={page >= totalPages - 1}
                    style={{ background: "#080f1e", border: "1px solid #1e3a5f", borderRadius: 6, color: page >= totalPages - 1 ? "#1e3a5f" : "#64748b", fontSize: 11, padding: "5px 10px", cursor: page >= totalPages - 1 ? "default" : "pointer" }}>▶▶</button>
                  <span style={{ fontSize: 11, color: "#334155", marginLeft: 8 }}>
                    {filteredCatalogue.length.toLocaleString()} oggetti · {PAGE_SIZE}/pag
                  </span>
                </div>
              )}
            </div>
          )}

          {tab === "setup" && (
            <SetupTab
              settings={settings}
              s={s}
              fieldStyle={fieldStyle}
              fov={fov}
              fovData={fovData}
              t={t}
            />
          )}

          {/* ── Tab: Horizon ── */}
          {tab === "horizon" && (
            <div style={{ maxWidth: 600 }}>
              <div style={{ fontSize: 14, color: "#93c5fd", marginBottom: 10, letterSpacing: 1 }}>{t("horizonTitle")}</div>
              <div style={{ fontSize: 12, color: "#475569", marginBottom: 20, lineHeight: 1.7 }}>
                {t("horizonDesc")}<br />
                {t("horizonExample")}
              </div>

              <div style={{
                border: "2px dashed #1e3a5f",
                borderRadius: 10,
                padding: 30,
                textAlign: "center",
                cursor: "pointer",
                position: "relative",
              }}>
                <input type="file" accept=".csv,.txt" onChange={handleHorizonFile}
                  style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }} />
                <div style={{ fontSize: 30, marginBottom: 8 }}>📂</div>
                <div style={{ fontSize: 13, color: "#475569" }}>
                  {horizonName ? <span style={{ color: "#4ade80" }}>✓ {horizonName}</span> : t("dropzone")}
                </div>
              </div>

              {horizonProfile && <HorizonPreview profile={horizonProfile} lang={lang} t={t} />}

              {!horizonProfile && (
                <div style={{ marginTop: 20, background: "#0a1628", borderRadius: 8, padding: 14, border: "1px solid #1e3a5f", fontSize: 12, color: "#475569" }}>
                  {t("noProfileWarning")}
                </div>
              )}

              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 12, color: "#475569", marginBottom: 8 }}>{t("uniformAlt")}</div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input type="number" min={0} max={45} step={0.5} placeholder="es. 5"
                    style={{ ...fieldStyle, width: 100 }}
                    onChange={e => {
                      const alt = +e.target.value;
                      if (!isNaN(alt)) setHorizonProfile(new Array(360).fill(alt));
                    }} />
                  <span style={{ fontSize: 12, color: "#64748b" }}>{t("uniformAltLabel")}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
