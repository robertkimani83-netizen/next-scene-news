// Renders the real map graphics for the "Map Challenge" Shorts series (see
// MAP_CHALLENGE_POOL + the isMapFormat branch in generate-short.mjs): a
// country's actual, accurate silhouette highlighted on a spinning-globe-style
// map, shown at progressively closer zoom across 3 clue segments, then a
// full-zoom reveal frame.
//
// This is a genuinely different visual format from "Guess the Country" (that
// series is pure trivia — a generic mystery card, no map at all). Here the
// map itself IS the puzzle: the viewer is watching real, correctly-shaped
// country borders zoom in, not reading clue text over a flat color card.
//
// Country boundary accuracy comes entirely from the `world-atlas` npm
// package (Natural Earth data pre-built into TopoJSON, MIT-licensed) — no
// hand-typed lat/lon guesses, no external image/network fetch at render
// time, so this never depends on an internet call succeeding mid-run.
// `d3-geo` projects + `sharp` rasterizes the SVG we build by hand (no DOM/
// canvas dependency — d3-geo's path generator returns plain SVG path
// strings when called without a canvas context).
//
// Every render here is a plain PNG, so the rest of the pipeline treats it as
// an ordinary `visual.type: "image"` — same Ken Burns pan/zoom, same caption
// burn-in, same optional flag badge as any fetched stock photo. See the
// isMapFormat segment-visual branch in generate-short.mjs for how these
// paths get wired in; zero changes were needed in ffmpeg-build.mjs.

import path from "node:path";
import { geoOrthographic, geoPath, geoCentroid, geoDistance } from "d3-geo";
import * as topojson from "topojson-client";
import sharp from "sharp";
import world50 from "world-atlas/countries-50m.json" with { type: "json" };

const W = 1080;
const H = 1920;

// Matches the dark navy brand background already used for the "Guess the
// Country" mystery/countdown cards (0x0B0F1A in ffmpeg's color= syntax —
// same hex, just CSS notation here since this is independent SVG/PNG
// rendering, not an ffmpeg filtergraph).
const BG = "#0B0F1A";
const LAND = "#212A40";
const LAND_STROKE = "#38455F";
const OCEAN = "#141B2E";
const OCEAN_STROKE = "#293552";

const countries = topojson.feature(world50, world50.objects.countries).features;

function findCountry(name) {
  const f = countries.find((c) => c.properties.name === name);
  if (!f) {
    throw new Error(
      `map-challenge: "${name}" not found in world-atlas's countries-50m dataset — ` +
      `every MAP_CHALLENGE_POOL entry in generate-short.mjs must match a properties.name in that dataset exactly.`
    );
  }
  return f;
}

/** Angular radius (radians, great-circle) from a country's centroid to its
 * farthest boundary vertex — used to fit the "reveal" zoom scale to the
 * country's actual real-world size (Mongolia and Brunei need wildly
 * different projection scales to both look correctly "zoomed in"). */
function angularRadius(feature, centroid) {
  let max = 0;
  const polys = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      for (const pt of ring) {
        const d = geoDistance(centroid, pt);
        if (d > max) max = d;
      }
    }
  }
  return max || 0.05; // guards against a degenerate single-point geometry
}

// This codebase's ffmpeg color convention is "0xRRGGBB" (see CARD_THEMES in
// ffmpeg-build.mjs); SVG/CSS wants "#RRGGBB".
function toCss(hex) {
  return "#" + String(hex).replace(/^0x/i, "");
}

async function renderStage(feature, { scale, ring, headerLines, accent, outPath }) {
  const centroid = geoCentroid(feature);
  const [lon, lat] = centroid;
  const headerH = headerLines ? 260 : 0;
  const mapCenterY = headerH + (H - headerH) / 2;

  const projection = geoOrthographic()
    .rotate([-lon, -lat])
    .translate([W / 2, mapCenterY])
    .scale(scale)
    .clipAngle(90);
  const geoPathGen = geoPath(projection); // no context given -> returns SVG path `d` strings directly

  const spherePath = geoPathGen({ type: "Sphere" });

  let landPaths = "";
  for (const f of countries) {
    const d = geoPathGen(f);
    if (!d) continue; // not visible on this side of the globe at this rotation
    const isTarget = f.properties.name === feature.properties.name;
    const fill = isTarget ? accent.fill : LAND;
    const stroke = isTarget ? accent.stroke : LAND_STROKE;
    const sw = isTarget ? 3 : 1;
    landPaths += `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
  }

  // A pulsing-style locator ring at the country's exact centroid — without
  // this, a tiny country (Bahrain, Brunei) is just an invisible speck at the
  // wide "CLUE 1" zoom level, which isn't a clue at all, just an unfair
  // blank map.
  let ringSvg = "";
  if (ring) {
    const c = projection(centroid);
    if (c) {
      ringSvg =
        `<circle cx="${c[0]}" cy="${c[1]}" r="70" fill="none" stroke="${accent.fill}" stroke-width="4" opacity="0.5"/>` +
        `<circle cx="${c[0]}" cy="${c[1]}" r="34" fill="none" stroke="${accent.fill}" stroke-width="3" opacity="0.85"/>`;
    }
  }

  let headerSvg = "";
  if (headerLines) {
    const [main, sub] = headerLines;
    headerSvg =
      `<text x="${W / 2}" y="150" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="72" fill="white" text-anchor="middle">${main}</text>` +
      (sub
        ? `<text x="${W / 2}" y="206" font-family="DejaVu Sans, sans-serif" font-size="32" fill="${accent.fill}" text-anchor="middle" letter-spacing="2">${sub}</text>`
        : "");
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${BG}"/>
    <path d="${spherePath}" fill="${OCEAN}" stroke="${OCEAN_STROKE}" stroke-width="2"/>
    ${landPaths}
    ${ringSvg}
    ${headerSvg}
  </svg>`;

  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

/**
 * Renders the 4 map-graphic frames for one "Map Challenge" Short: 3
 * progressively-zoomed clue stages (real, accurate country silhouette
 * highlighted on the globe, never labeled with the country's name) plus a
 * full-zoom reveal frame. All 4 are plain PNGs — the caller wires them in as
 * `visual.type: "image"` visuals, same as any fetched stock photo, so they
 * get the same Ken Burns treatment automatically.
 *
 * @param {string} countryName - must exactly match a `properties.name` in
 *   world-atlas's countries-50m dataset. Every entry in MAP_CHALLENGE_POOL
 *   (generate-short.mjs) is verified against this dataset already.
 * @param {string} outDir - this run's scratch directory
 * @param {{accent?: string}} [theme] - theme.accent from CARD_THEMES
 *   ("0xRRGGBB"), so the map's highlight color matches whichever accent
 *   theme this video happened to rotate to instead of always looking
 *   identical video to video. Falls back to gold if omitted.
 * @returns {Promise<{stage1:string, stage2:string, stage3:string, reveal:string}>}
 */
export async function renderMapChallengeCards(countryName, outDir, theme) {
  const feature = findCountry(countryName);
  const centroid = geoCentroid(feature);
  const angRad = angularRadius(feature, centroid);

  const accent = { fill: toCss(theme?.accent ?? "0xFFD700"), stroke: "#FFFFFF" };

  // Fit the "reveal" scale to the country's real angular size so it always
  // fills a comfortable fraction of the frame, then derive the two closer
  // clue stages as fractions of that — clamped so an extreme case (a
  // continent-sized country, or a country so small it's barely a dot at
  // 50m resolution) never breaks the layout.
  const revealScale = Math.min(Math.max(340 / angRad, 900), 7000);
  const stage3Scale = Math.max(revealScale * 0.55, 700);
  const stage2Scale = Math.min(Math.max(revealScale * 0.18, 480), 1100);
  const stage1Scale = 420; // fixed continent/world view — same starting point for every country

  const stage1 = path.join(outDir, "map_stage1.png");
  const stage2 = path.join(outDir, "map_stage2.png");
  const stage3 = path.join(outDir, "map_stage3.png");
  const reveal = path.join(outDir, "map_reveal.png");

  await renderStage(feature, { scale: stage1Scale, ring: true, headerLines: ["CLUE 1", "MAP CHALLENGE"], accent, outPath: stage1 });
  await renderStage(feature, { scale: stage2Scale, ring: true, headerLines: ["CLUE 2", "MAP CHALLENGE"], accent, outPath: stage2 });
  await renderStage(feature, { scale: stage3Scale, ring: false, headerLines: ["CLUE 3", "MAP CHALLENGE"], accent, outPath: stage3 });
  await renderStage(feature, { scale: revealScale, ring: false, headerLines: null, accent, outPath: reveal });

  return { stage1, stage2, stage3, reveal };
}
