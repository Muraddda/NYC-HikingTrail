const CORRIDOR_M = 150;
const SNAP_M = 80;
const OSRM = [
  "https://router.project-osrm.org/route/v1/foot/",
  "https://routing.openstreetmap.de/routed-foot/route/v1/foot/",
];
const ZONE_POLY = [
  [40.7155, -74.0178], [40.7155, -74.0012], [40.7128, -73.9978], [40.7088, -73.9968],
  [40.7048, -73.9976], [40.7016, -74.0008], [40.7004, -74.0088], [40.7006, -74.0168],
  [40.7034, -74.0188], [40.7078, -74.0186], [40.712, -74.0176],
];
const CAT_COLOR = {
  art: "#c45c26", oddity: "#2f5d4e", history: "#1c1b18",
  food: "#8a5a2b", bar: "#6b3a4a", shop: "#3d4a5c", other: "#4a4740",
};
const $ = (id) => document.getElementById(id);
const els = {
  hint: $("hint"), hintTitle: $("hint-title"), hintBody: $("hint-body"), toast: $("toast"),
  sheet: $("sheet"), sheetCount: $("sheet-count"), sheetYes: $("sheet-yes"),
  placeName: $("place-name"), placeBucket: $("place-bucket"), placeLiner: $("place-liner"), placeLink: $("place-link"),
  btnYes: $("btn-yes"), btnNo: $("btn-no"), btnUndo: $("btn-undo"),
  btnReview: $("btn-review"), btnPlan: $("btn-plan"), btnPlanSheet: $("btn-plan-sheet"),
  btnClear: $("btn-clear"), summary: $("summary"), summaryBody: $("summary-body"),
};
let map, places = [];
let start = null, end = null, startMarker = null, endMarker = null;
let waypoints = [];
let rubberLine = null, grabLine = null, streetLayer = null;
let catalogLayer, pinLayer, handleLayer, spurLayer;
let candidates = [];
let rejected = [];
let plannedStops = [];
let phase = "idle";
let dragging = false;
let toastTimer = null;
function pointInPoly(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}
const inZone = (lat, lng) => pointInPoly(lat, lng, ZONE_POLY);
function haversine(a, b) {
  const R = 6371000, tr = (d) => (d * Math.PI) / 180;
  const dLat = tr(b.lat - a.lat), dLng = tr(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a.lat)) * Math.cos(tr(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function projectOnSegment(p, a, b) {
  const mid = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const bx = (b.lng - a.lng) * Math.cos(mid), by = b.lat - a.lat;
  const px = (p.lng - a.lng) * Math.cos(mid), py = p.lat - a.lat;
  const len2 = bx * bx + by * by;
  let t = len2 === 0 ? 0 : (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
}
function distanceToLine(point, line) {
  let best = Infinity, along = 0, walked = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const proj = projectOnSegment(point, line[i], line[i + 1]);
    const d = haversine(point, proj);
    if (d < best) { best = d; along = walked + haversine(line[i], proj); }
    walked += haversine(line[i], line[i + 1]);
  }
  return { distance: best, along };
}
function axisT(p, a, b) {
  const mid = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const vx = (b.lng - a.lng) * Math.cos(mid), vy = b.lat - a.lat;
  const wx = (p.lng - a.lng) * Math.cos(mid), wy = p.lat - a.lat;
  const len2 = vx * vx + vy * vy;
  return len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
}
function entranceOf(p) { return { lat: p.entrance_lat ?? p.lat, lng: p.entrance_lng ?? p.lng }; }
function lineLeavesZone(line) {
  if (!line.length) return true;
  return line.filter((p) => !inZone(p.lat, p.lng)).length > line.length * 0.45;
}
async function fetchRoute(points) {
  const path = points.map((p) => `${p.lng},${p.lat}`).join(";") + "?overview=full&geometries=geojson&continue_straight=true";
  let last = new Error("router");
  for (const base of OSRM) {
    try {
      const res = await fetch(base + path);
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.routes?.[0]) continue;
      return data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    } catch (e) { last = e; }
  }
  throw last;
}
async function stitch(points) {
  const line = await fetchRoute(points);
  if (lineLeavesZone(line)) throw new Error("off-island");
  return line;
}
function nearestOnLine(point, line) {
  let best = line[0], bestD = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const proj = projectOnSegment(point, line[i], line[i + 1]);
    const d = haversine(point, proj);
    if (d < bestD) { bestD = d; best = proj; }
  }
  return { point: best, distance: bestD };
}
function thinVias(stops) {
  if (stops.length <= 2) return stops;
  const last = stops[stops.length - 1];
  const kept = [stops[0]];
  for (let i = 1; i < stops.length - 1; i++) {
    const { distance } = distanceToLine(entranceOf(stops[i]), [entranceOf(kept[kept.length - 1]), entranceOf(last)]);
    if (distance > 90) kept.push(stops[i]);
  }
  kept.push(last);
  if (kept.length > 4) {
    const tighter = [kept[0]];
    const fin = kept[kept.length - 1];
    for (let i = 1; i < kept.length - 1; i++) {
      const { distance } = distanceToLine(entranceOf(kept[i]), [entranceOf(tighter[tighter.length - 1]), entranceOf(fin)]);
      if (distance > 140) tighter.push(kept[i]);
    }
    tighter.push(fin);
    return tighter;
  }
  return kept;
}
function hint(title, body) {
  els.hint.hidden = false; els.hintTitle.textContent = title; els.hintBody.textContent = body;
}
function toast(msg) {
  els.toast.hidden = false; els.toast.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}
function abIcon(letter, color) {
  return L.divIcon({ className: "", html: `<div class="pin-label" style="background:${color}">${letter}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}
function handleIcon(wp) {
  if (wp.place) {
    return L.divIcon({ className: "", html: `<div class="wp-wrap"><div class="wp-name">${wp.place.name}</div><div class="pin-label" style="background:#c45c26">●</div></div>`, iconSize: [180, 48], iconAnchor: [90, 36] });
  }
  return L.divIcon({ className: "", html: `<div class="pin-label" style="background:#c45c26">+</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}
function nearestPlace(pt) {
  let best = null, bestD = SNAP_M;
  for (const place of places) { const d = haversine(pt, place); if (d <= bestD) { best = place; bestD = d; } }
  return best;
}
function snappedIds() {
  const ids = new Set();
  waypoints.forEach((wp) => { if (wp.place) ids.add(wp.place.id); });
  return ids;
}
function controlPoints() {
  const pts = [];
  if (start) pts.push(start);
  waypoints.forEach((wp) => pts.push({ lat: wp.lat, lng: wp.lng }));
  if (end) pts.push(end);
  return pts;
}
function pending() { return candidates.filter((p) => p.verdict === "pending"); }
function yeses() { return candidates.filter((p) => p.verdict === "yes"); }
function shortName(name) {
  if (name.length <= 18) return name;
  const bits = name.split(" ");
  if (bits.length === 1) return name.slice(0, 16) + "…";
  return bits.slice(0, 2).join(" ");
}
function catColor(place) { return CAT_COLOR[place.category] || "#1c1b18"; }
function drawRubber() {
  const latlngs = controlPoints().map((p) => [p.lat, p.lng]);
  if (rubberLine) rubberLine.setLatLngs(latlngs).setStyle({ opacity: 0.95 });
  else rubberLine = L.polyline(latlngs, { color: "#c45c26", weight: 4, opacity: 0.95, interactive: false }).addTo(map);
  if (grabLine) grabLine.setLatLngs(latlngs).setStyle({ opacity: 0.001, interactive: true });
  else {
    grabLine = L.polyline(latlngs, { color: "#c45c26", weight: 28, opacity: 0.001 }).addTo(map);
    grabLine.on("click", (e) => {
      if (phase === "done" || phase === "idle" || !start || !end) return;
      L.DomEvent.stop(e);
      const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (!inZone(pt.lat, pt.lng)) { toast("Stay south of Chambers, on Manhattan."); return; }
      const place = nearestPlace(pt);
      waypoints.push(place ? { lat: place.lat, lng: place.lng, place, id: "wp-" + Date.now() } : { lat: pt.lat, lng: pt.lng, place: null, id: "wp-" + Date.now() });
      refreshShape();
    });
  }
}
function drawHandles() {
  handleLayer.clearLayers();
  waypoints.forEach((wp) => {
    const marker = L.marker([wp.lat, wp.lng], { icon: handleIcon(wp), draggable: true }).addTo(handleLayer);
    marker.on("dragstart", () => { dragging = true; });
    marker.on("drag", (e) => {
      const ll = e.target.getLatLng();
      const place = nearestPlace({ lat: ll.lat, lng: ll.lng });
      if (place) { wp.lat = place.lat; wp.lng = place.lng; wp.place = place; }
      else { wp.lat = ll.lat; wp.lng = ll.lng; wp.place = null; }
      e.target.setLatLng([wp.lat, wp.lng]); e.target.setIcon(handleIcon(wp)); drawRubber();
    });
    marker.on("dragend", () => {
      const ll = marker.getLatLng();
      if (!inZone(ll.lat, ll.lng)) { toast("Stay south of Chambers, on Manhattan."); waypoints = waypoints.filter((w) => w.id !== wp.id); }
      dragging = false; refreshShape();
    });
    marker.on("click", (e) => { L.DomEvent.stop(e); waypoints = waypoints.filter((w) => w.id !== wp.id); refreshShape(); });
  });
}
function labelFor(place, onWalk, order, zoom) {
  if (onWalk && phase === "done") return zoom >= 15 ? `${order + 1}  ${place.name}` : String(order + 1);
  if (onWalk) return zoom >= 15 ? place.name : "";
  if (zoom >= 18) return place.name;
  if (zoom >= 16) return shortName(place.name);
  return "";
}
function drawCatalog() {
  if (!map || !catalogLayer) return;
  catalogLayer.clearLayers();
  const zoom = map.getZoom();
  const snapped = snappedIds();
  const plannedIndex = new Map(plannedStops.map((p, i) => [p.id, i]));
  places.forEach((place) => {
    const order = plannedIndex.has(place.id) ? plannedIndex.get(place.id) : -1;
    const onWalk = order >= 0 || snapped.has(place.id);
    const color = onWalk && phase === "done" ? "#2f5d4e" : catColor(place);
    const label = labelFor(place, onWalk, order, zoom);
    if (label) {
      const numbered = onWalk && phase === "done" && zoom < 15;
      const html = numbered
        ? `<div class="name-chip on-walk"><div class="num">${label}</div></div>`
        : `<div class="name-chip ${onWalk ? "on-walk" : ""}"><div class="dot" style="background:${color}"></div><div class="txt">${label}</div></div>`;
      L.marker([place.lat, place.lng], { icon: L.divIcon({ className: "", html, iconSize: [160, 40], iconAnchor: [80, 8] }), interactive: false, zIndexOffset: onWalk ? 400 : 100 }).addTo(catalogLayer);
    } else {
      L.circleMarker([place.lat, place.lng], { radius: onWalk ? 7 : 5.5, color: "#f3efe6", weight: 2, fillColor: color, fillOpacity: 0.95, interactive: false }).addTo(catalogLayer);
    }
  });
}
function rebuildCandidates() {
  const guide = controlPoints();
  if (guide.length < 2) return;
  const skip = snappedIds();
  const prev = new Map(candidates.map((c) => [c.id, c.verdict]));
  const near = [];
  places.forEach((place) => {
    if (skip.has(place.id)) return;
    const { distance, along } = distanceToLine(place, guide);
    if (distance <= CORRIDOR_M) near.push({ ...place, distance, along, verdict: prev.get(place.id) || "pending" });
  });
  near.sort((a, b) => a.along - b.along);
  candidates = near;
}
function drawReviewPins() {
  pinLayer.clearLayers();
  const current = pending()[0];
  candidates.forEach((place) => {
    if (place.verdict === "no") return;
    if (current && place.id === current.id) {
      L.marker([place.lat, place.lng], { icon: L.divIcon({ className: "", html: `<div class="active-ring"></div>`, iconSize: [28, 28], iconAnchor: [14, 14] }), interactive: false }).addTo(pinLayer);
    } else {
      L.circleMarker([place.lat, place.lng], { radius: place.verdict === "yes" ? 8 : 7, color: "#f3efe6", weight: 2, fillColor: place.verdict === "yes" ? "#2f5d4e" : "#c45c26", fillOpacity: 1, interactive: false }).addTo(pinLayer);
    }
  });
}
function openCard() {
  const place = pending()[0];
  if (!place) { els.sheet.hidden = true; els.btnPlan.hidden = false; hint("Stops picked", "Tap Plan route to walk first stop to last stop."); return; }
  phase = "review"; els.summary.hidden = true; els.sheet.hidden = false; els.btnReview.hidden = true; els.btnPlan.hidden = false;
  const left = pending().length, total = candidates.length;
  els.sheetCount.textContent = `${total - left + 1} of ${total}`;
  els.sheetYes.textContent = `${yeses().length} extra stop${yeses().length === 1 ? "" : "s"}`;
  els.placeName.textContent = place.name; els.placeBucket.textContent = place.category;
  els.placeLiner.textContent = place.one_liner; els.placeLink.href = place.source_url;
  els.btnUndo.hidden = rejected.length === 0;
  drawReviewPins(); drawCatalog(); map.panTo([place.lat, place.lng]);
}
function refreshShape() {
  if (!start || !end) return;
  drawRubber(); drawHandles(); drawCatalog();
  if (phase === "done") return;
  els.sheet.hidden = true; els.btnReview.hidden = false; els.btnPlan.hidden = true;
  hint("Shape the walk", "Pull the orange line onto spots or streets. When it looks right, tap Select stops.");
}
function hideSketch() {
  if (rubberLine) { map.removeLayer(rubberLine); rubberLine = null; }
  if (grabLine) { map.removeLayer(grabLine); grabLine = null; }
}
function startSelecting() {
  if (!start || !end) return;
  rebuildCandidates();
  els.btnReview.hidden = true; els.btnPlan.hidden = false;
  if (!candidates.length) { hint("No extra stops", "Snap or Yes at least two spots, then Plan route."); return; }
  openCard();
}
async function planRoute() {
  if (!start || !end) return;
  const extra = yeses();
  const named = []; const seen = new Set();
  waypoints.forEach((wp) => { if (wp.place && !seen.has(wp.place.id)) { seen.add(wp.place.id); named.push(wp.place); } });
  extra.forEach((p) => { if (seen.has(p.id)) return; seen.add(p.id); named.push(p); });
  named.sort((a, b) => axisT(entranceOf(a), start, end) - axisT(entranceOf(b), start, end));
  if (named.length < 2) {
    toast("Pick at least two stops before planning.");
    hint("Need two stops", "Yes at least two spots, or snap the line onto two pins, then Plan route.");
    els.btnPlan.hidden = false; return;
  }
  pending().forEach((p) => { p.verdict = "no"; });
  els.sheet.hidden = true; els.btnPlan.hidden = true;
  hint("Planning the walk", "One street spine. Nearby stops get a dotted spur.");
  hideSketch();
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
  pinLayer.clearLayers(); handleLayer.clearLayers(); spurLayer.clearLayers();
  try {
    const vias = thinVias(named);
    let line = await stitch(vias.map(entranceOf));
    const detour = line.reduce((sum, p, i, arr) => i ? sum + haversine(arr[i - 1], p) : 0, 0);
    const straight = haversine(entranceOf(named[0]), entranceOf(named[named.length - 1]));
    if (straight > 0 && detour / straight > 1.85) {
      line = await stitch([entranceOf(named[0]), entranceOf(named[named.length - 1])]);
    }
    if (streetLayer) map.removeLayer(streetLayer);
    streetLayer = L.polyline(line.map((p) => [p.lat, p.lng]), { color: "#2f5d4e", weight: 5, opacity: 0.9, interactive: false }).addTo(map);
    named.forEach((p) => {
      const door = entranceOf(p);
      const snap = nearestOnLine(door, line);
      if (snap.distance < 12) return;
      L.polyline([[snap.point.lat, snap.point.lng], [p.lat, p.lng]], { color: "#2f5d4e", weight: 3, opacity: 0.85, dashArray: "6 8", interactive: false }).addTo(spurLayer);
    });
    plannedStops = named; phase = "done"; drawCatalog();
    map.fitBounds(streetLayer.getBounds(), { padding: [50, 160] });
    els.hint.hidden = true; els.summary.hidden = false;
    els.summaryBody.innerHTML = `<ol>${named.map((s) => `<li><strong>${s.name}</strong> — ${s.one_liner}</li>`).join("")}</ol>`;
  } catch {
    els.btnPlan.hidden = false;
    toast("Could not plan that walk. Try two stops farther apart.");
  }
}
async function init() {
  map = L.map("map", { zoomControl: false }).setView([40.7072, -74.0105], 15);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 19, attribution: "&copy; OSM &copy; CARTO" }).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.polygon(ZONE_POLY, { color: "transparent", weight: 0, fillColor: "#2f5d4e", fillOpacity: 0.16, interactive: false }).addTo(map);
  catalogLayer = L.layerGroup().addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  handleLayer = L.layerGroup().addTo(map);
  spurLayer = L.layerGroup().addTo(map);
  const data = await fetch("places.json").then((r) => r.json());
  places = data.places.filter((p) => inZone(p.lat, p.lng));
  drawCatalog();
  map.on("zoomend", drawCatalog);
  map.on("click", (e) => {
    if (dragging) return;
    if (phase === "done" || phase === "review" || phase === "shaping") return;
    const { lat, lng } = e.latlng;
    if (!inZone(lat, lng)) { toast("MVP only works south of Chambers Street, on Manhattan."); return; }
    if (!start) {
      start = { lat, lng };
      startMarker = L.marker([lat, lng], { icon: abIcon("A", "#2f5d4e"), draggable: true }).addTo(map);
      startMarker.on("dragend", (ev) => {
        const ll = ev.target.getLatLng();
        if (!inZone(ll.lat, ll.lng)) { toast("Start must stay in the wash."); startMarker.setLatLng([start.lat, start.lng]); return; }
        start = { lat: ll.lat, lng: ll.lng }; if (end) refreshShape();
      });
      els.btnClear.hidden = false; phase = "end"; hint("Start is set", "Tap your end point."); return;
    }
    if (!end) {
      if (haversine(start, { lat, lng }) < 40) { toast("End is too close to start."); return; }
      end = { lat, lng };
      endMarker = L.marker([lat, lng], { icon: abIcon("B", "#1c1b18"), draggable: true }).addTo(map);
      endMarker.on("dragend", (ev) => {
        const ll = ev.target.getLatLng();
        if (!inZone(ll.lat, ll.lng)) { toast("End must stay in the wash."); endMarker.setLatLng([end.lat, end.lng]); return; }
        end = { lat: ll.lat, lng: ll.lng }; refreshShape();
      });
      phase = "shaping"; els.btnReview.hidden = false;
      hint("Pull the line", "Drag the orange line onto a spot or a street. Then tap Select stops.");
      drawRubber(); refreshShape();
    }
  });
  els.btnClear.addEventListener("click", () => location.reload());
  els.btnReview.addEventListener("click", startSelecting);
  els.btnPlan.addEventListener("click", () => void planRoute());
  els.btnPlanSheet.addEventListener("click", () => void planRoute());
  els.btnYes.addEventListener("click", () => { const p = pending()[0]; if (!p) return; p.verdict = "yes"; openCard(); });
  els.btnNo.addEventListener("click", () => { const p = pending()[0]; if (!p) return; p.verdict = "no"; rejected.push(p.id); openCard(); });
  els.btnUndo.addEventListener("click", () => { const id = rejected.pop(); const p = candidates.find((c) => c.id === id); if (p) p.verdict = "pending"; openCard(); });
}
init().catch(() => hint("Could not load places", "Make sure places.json sits next to this page."));
