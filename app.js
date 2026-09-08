const CORRIDOR_M = 150;
const SNAP_M = 80;
const OSRM = [
  "https://router.project-osrm.org/route/v1/foot/",
  "https://routing.openstreetmap.de/routed-foot/route/v1/foot/",
];
const ZONE_POLY = [
  [40.7496, -74.0108],
  [40.7472, -74.0042],
  [40.7454, -73.9988],
  [40.7434, -73.9934],
  [40.7418, -73.9896],
  [40.7404, -73.9860],
  [40.7384, -73.9816],
  [40.7369, -73.9776],
  [40.7356, -73.9742],
  [40.7312, -73.9736],
  [40.7200, -73.9738],
  [40.7105, -73.9788],
  [40.7062, -73.9968],
  [40.7048, -74.0008],
  [40.7010, -74.0088],
  [40.7004, -74.0168],
  [40.7034, -74.0188],
  [40.7120, -74.0178],
  [40.7235, -74.0132],
  [40.7335, -74.0112],
  [40.7422, -74.0090],
];
const CAT_COLOR = {
  architecture: "#1c1b18",
  oddity: "#2f5d4e",
  art: "#c45c26",
  history: "#1c1b18",
  food: "#8a5a2b",
  bar: "#6b3a4a",
  shop: "#3d4a5c",
  other: "#4a4740",
};

const $ = (id) => document.getElementById(id);
const els = {
  hint: $("hint"), hintTitle: $("hint-title"), hintBody: $("hint-body"), toast: $("toast"),
  sheet: $("sheet"),
  btnReview: $("btn-review"), btnPlan: $("btn-plan"),
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
let reviewPopup = null;
let flyToken = 0;
let reviewFirst = true;
let adoptRestore = null;
let focusPlaceId = null;
let reviewCurrentId = null;
let phase = "idle";
let dragging = false;
let pullingWp = null;
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
function entranceOf(p) {
  return { lat: p.entrance_lat ?? p.lat, lng: p.entrance_lng ?? p.lng };
}
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
function insertStop(stops, place) {
  if (!stops.length) return [place];
  if (stops.some((s) => s.id === place.id)) return stops.slice();
  const door = entranceOf(place);
  let bestAt = stops.length;
  let bestCost = haversine(entranceOf(stops[stops.length - 1]), door);
  const head = haversine(door, entranceOf(stops[0]));
  if (head < bestCost) {
    bestCost = head;
    bestAt = 0;
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const a = entranceOf(stops[i]);
    const b = entranceOf(stops[i + 1]);
    const extra = haversine(a, door) + haversine(door, b) - haversine(a, b);
    if (extra < bestCost) {
      bestCost = extra;
      bestAt = i + 1;
    }
  }
  const next = stops.slice();
  next.splice(bestAt, 0, place);
  return next;
}
function orderStops(stops) {
  const list = stops.slice();
  if (list.length <= 2) return list;
  const origin = start || { lat: list[0].lat, lng: list[0].lng };
  const dest = end || { lat: list[list.length - 1].lat, lng: list[list.length - 1].lng };
  const unused = list.slice();
  const ordered = [];
  let cur = unused.reduce((best, p) => (
    haversine(entranceOf(p), origin) < haversine(entranceOf(best), origin) ? p : best
  ));
  ordered.push(cur);
  unused.splice(unused.indexOf(cur), 1);
  while (unused.length) {
    const last = ordered[ordered.length - 1];
    const next = unused.reduce((best, p) => (
      haversine(entranceOf(p), entranceOf(last)) < haversine(entranceOf(best), entranceOf(last)) ? p : best
    ));
    ordered.push(next);
    unused.splice(unused.indexOf(next), 1);
  }
  const forward = haversine(entranceOf(ordered[0]), origin) + haversine(entranceOf(ordered[ordered.length - 1]), dest);
  const backward = haversine(entranceOf(ordered[ordered.length - 1]), origin) + haversine(entranceOf(ordered[0]), dest);
  if (backward < forward) ordered.reverse();
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < ordered.length - 2; i++) {
      for (let j = i + 2; j < ordered.length; j++) {
        const a = entranceOf(ordered[i]);
        const b = entranceOf(ordered[i + 1]);
        const c = entranceOf(ordered[j]);
        const d = j + 1 < ordered.length ? entranceOf(ordered[j + 1]) : null;
        const before = haversine(a, b) + (d ? haversine(c, d) : 0);
        const after = haversine(a, c) + (d ? haversine(b, d) : 0);
        if (after + 2 < before) {
          const mid = ordered.slice(i + 1, j + 1).reverse();
          ordered.splice(i + 1, j - i, ...mid);
          improved = true;
        }
      }
    }
  }
  return ordered;
}
function touchesStop(pts, from, to, stops) {
  for (let i = from; i <= to; i++) {
    for (const s of stops) {
      if (haversine(pts[i], entranceOf(s)) < 22) return true;
    }
  }
  return false;
}
function lineServesStops(line, stops) {
  return stops.every((s) => nearestOnLine(entranceOf(s), line).distance < 45);
}
function stripLoops(line, stops) {
  if (!line || line.length < 8) return line;
  const pts = line.slice();
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 12) {
    changed = false;
    for (let i = 0; i < pts.length - 6; i++) {
      for (let j = i + 6; j < pts.length; j++) {
        const gap = haversine(pts[i], pts[j]);
        if (gap > 22) continue;
        let walked = 0;
        for (let k = i; k < j; k++) walked += haversine(pts[k], pts[k + 1]);
        if (walked < 220 || walked < gap * 8) continue;
        if (touchesStop(pts, i + 1, j - 1, stops)) continue;
        const trial = pts.slice(0, i + 1).concat(pts.slice(j));
        if (!lineServesStops(trial, stops)) continue;
        pts.splice(i + 1, j - i - 1);
        changed = true;
        break;
      }
      if (changed) break;
    }
  }
  return lineServesStops(pts, stops) ? pts : line;
}
function hint(title, body) {
  els.hint.hidden = false;
  els.hintTitle.textContent = title;
  els.hintBody.textContent = body;
}
function toast(msg) {
  els.toast.hidden = false;
  els.toast.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}
function abIcon(letter, color) {
  return L.divIcon({ className: "", html: `<div class="pin-label" style="background:${color}">${letter}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}
function handleIcon(wp) {
  if (wp.place) {
    return L.divIcon({
      className: "",
      html: `<div class="wp-wrap"><div class="wp-name">${wp.place.name}</div><div class="pin-label" style="background:#c45c26">●</div></div>`,
      iconSize: [180, 48], iconAnchor: [90, 36],
    });
  }
  return L.divIcon({ className: "", html: `<div class="pin-label" style="background:#c45c26">+</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}
function nearestPlace(pt) {
  let best = null, bestD = SNAP_M;
  for (const place of places) {
    const d = haversine(pt, place);
    if (d <= bestD) { best = place; bestD = d; }
  }
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
function catColor(place) {
  return CAT_COLOR[place.category] || "#1c1b18";
}

function finishPull() {
  if (!pullingWp) return;
  const wp = pullingWp;
  pullingWp = null;
  dragging = false;
  if (map.dragging) map.dragging.enable();
  if (!inZone(wp.lat, wp.lng)) {
    toast("Stay south of 23rd, on Manhattan.");
    waypoints = waypoints.filter((w) => w.id !== wp.id);
  } else {
    const place = nearestPlace(wp);
    if (place) {
      wp.lat = place.lat;
      wp.lng = place.lng;
      wp.place = place;
    }
  }
  refreshShape();
}

function drawRubber() {
  const latlngs = controlPoints().map((p) => [p.lat, p.lng]);
  if (rubberLine) rubberLine.setLatLngs(latlngs).setStyle({ opacity: 0.95 });
  else rubberLine = L.polyline(latlngs, { color: "#c45c26", weight: 4, opacity: 0.95, interactive: false }).addTo(map);
  if (grabLine) grabLine.setLatLngs(latlngs).setStyle({ opacity: pullingWp ? 0 : 0.001, interactive: !pullingWp });
  else {
    grabLine = L.polyline(latlngs, { color: "#c45c26", weight: 36, opacity: 0.001 }).addTo(map);
    grabLine.on("mousedown", (e) => {
      if (phase === "done" || phase === "idle" || phase === "review" || !start || !end) return;
      L.DomEvent.stop(e);
      if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
      const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (!inZone(pt.lat, pt.lng)) { toast("Stay south of 23rd, on Manhattan."); return; }
      pullingWp = { lat: pt.lat, lng: pt.lng, place: null, id: "wp-" + Date.now() };
      waypoints.push(pullingWp);
      dragging = true;
      map.dragging.disable();
      drawRubber();
    });
  }
}
function drawHandles() {
  handleLayer.clearLayers();
  if (pullingWp) return;
  waypoints.forEach((wp) => {
    const marker = L.marker([wp.lat, wp.lng], {
      icon: handleIcon(wp),
      draggable: true,
      autoPan: false,
      zIndexOffset: 800,
    }).addTo(handleLayer);
    let moved = false;
    marker.on("dragstart", () => {
      dragging = true;
      moved = false;
      map.dragging.disable();
      if (grabLine) grabLine.setStyle({ interactive: false });
    });
    marker.on("drag", (e) => {
      moved = true;
      const ll = e.target.getLatLng();
      wp.lat = ll.lat;
      wp.lng = ll.lng;
      wp.place = null;
      drawRubber();
    });
    marker.on("dragend", () => {
      const ll = marker.getLatLng();
      wp.lat = ll.lat;
      wp.lng = ll.lng;
      if (!inZone(ll.lat, ll.lng)) {
        toast("Stay south of 23rd, on Manhattan.");
        waypoints = waypoints.filter((w) => w.id !== wp.id);
      } else {
        const place = nearestPlace({ lat: ll.lat, lng: ll.lng });
        if (place) {
          wp.lat = place.lat;
          wp.lng = place.lng;
          wp.place = place;
        }
      }
      dragging = false;
      map.dragging.enable();
      refreshShape();
    });
    marker.on("click", (e) => {
      L.DomEvent.stop(e);
      if (moved) return;
      waypoints = waypoints.filter((w) => w.id !== wp.id);
      refreshShape();
    });
  });
}
function labelFor(place, onWalk, order, zoom) {
  if (onWalk && phase === "done") {
    return zoom >= 15 ? `${order + 1}  ${place.name}` : String(order + 1);
  }
  if (onWalk) return zoom >= 15 ? place.name : "";
  if (zoom >= 18) return place.name;
  if (zoom >= 16) return shortName(place.name);
  return "";
}
function drawCatalog() {
  if (!map || !catalogLayer) return;
  catalogLayer.clearLayers();
  const zoom = map.getZoom();
  const showName = zoom >= 16;
  const snapped = snappedIds();
  const plannedIndex = new Map(plannedStops.map((p, i) => [p.id, i]));
  places.forEach((place) => {
    const order = plannedIndex.has(place.id) ? plannedIndex.get(place.id) : -1;
    const onWalk = order >= 0 || snapped.has(place.id);
    const color = onWalk && phase === "done" ? "#2f5d4e" : catColor(place);
    const photo = place.photo_url || "placeholder.svg";
    const walkDone = onWalk && phase === "done";
    const title = walkDone ? `${order + 1}  ${place.name}` : place.name;
    const html = `<div class="name-chip ${walkDone ? "on-walk" : ""} ${showName ? "named" : "photo-only"}">
      <div class="photo-dot" style="border-color:${color}">
        <img src="${photo}" alt="">
        ${walkDone && !showName ? `<span class="num">${order + 1}</span>` : ""}
      </div>
      ${showName ? `<div class="txt">${title}</div>` : ""}
    </div>`;
    const marker = L.marker([place.lat, place.lng], {
      icon: L.divIcon({
        className: "",
        html,
        iconSize: showName ? [160, 58] : [28, 28],
        iconAnchor: showName ? [80, 16] : [14, 14],
      }),
      interactive: phase === "review" || phase === "done",
      zIndexOffset: onWalk ? 400 : 100,
    }).addTo(catalogLayer);
    if (phase === "review" || phase === "done") {
      marker.on("click", (e) => {
        L.DomEvent.stop(e);
        if (phase === "review") adoptOffRoutePlace(place);
        else openDoneCard(place);
      });
    }
  });
}
function adoptOffRoutePlace(place) {
  if (phase !== "review") return;
  if (snappedIds().has(place.id)) {
    toast(place.name + " is already on the walk.");
    return;
  }
  const already = candidates.find((c) => c.id === place.id);
  if (already && already.verdict === "pending" && !adoptRestore) {
    focusPlaceId = place.id;
    openCard();
    return;
  }
  if (already && already.verdict === "yes") {
    toast(place.name + " is already in range.");
    return;
  }
  const resumeId = reviewCurrentId || pending()[0]?.id || null;
  const wp = {
    lat: place.lat,
    lng: place.lng,
    place: null,
    tentative: true,
    targetId: place.id,
    id: "wp-" + Date.now(),
  };
  waypoints.push(wp);
  adoptRestore = { wpId: wp.id, resumeId, targetId: place.id };
  rebuildCandidates();
  const card = candidates.find((c) => c.id === place.id);
  if (card) card.verdict = "pending";
  drawRubber();
  drawHandles();
  focusPlaceId = place.id;
  hint("Add this stop?", "❤️ keep the detour. ✕ cancel and go back.");
  openCard();
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
  const current = (reviewCurrentId && candidates.find((p) => p.id === reviewCurrentId)) || pending()[0];
  candidates.forEach((place) => {
    if (place.verdict === "no") return;
    if (current && place.id === current.id) {
      L.marker([place.lat, place.lng], {
        icon: L.divIcon({ className: "", html: `<div class="active-ring"></div>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
        interactive: false,
      }).addTo(pinLayer);
    } else {
      L.circleMarker([place.lat, place.lng], {
        radius: place.verdict === "yes" ? 8 : 7,
        color: "#f3efe6", weight: 2,
        fillColor: place.verdict === "yes" ? "#2f5d4e" : "#c45c26",
        fillOpacity: 1, interactive: false,
      }).addTo(pinLayer);
    }
  });
}
function closeReviewPopup() {
  if (reviewPopup) {
    map.closePopup(reviewPopup);
    reviewPopup = null;
  }
}
function confirmReviewPlace(place, keep) {
  if (adoptRestore && adoptRestore.targetId === place.id) {
    const restore = adoptRestore;
    adoptRestore = null;
    if (keep) {
      const wp = waypoints.find((w) => w.id === restore.wpId);
      if (wp) {
        wp.place = place;
        wp.tentative = false;
      }
      place.verdict = "yes";
      rebuildCandidates();
      drawRubber();
      drawHandles();
      openCard();
      return;
    }
    waypoints = waypoints.filter((w) => w.id !== restore.wpId);
    rebuildCandidates();
    drawRubber();
    drawHandles();
    focusPlaceId = restore.resumeId;
    openCard();
    return;
  }
  if (keep) {
    place.verdict = "yes";
  } else {
    place.verdict = "no";
    rejected.push(place.id);
  }
  openCard();
}
function openCard() {
  closeReviewPopup();
  let place = pending()[0];
  if (focusPlaceId) {
    place = candidates.find((c) => c.id === focusPlaceId && c.verdict === "pending") || place;
    focusPlaceId = null;
  }
  reviewCurrentId = place ? place.id : null;
  if (!place) {
    if (els.sheet) els.sheet.hidden = true;
    els.btnPlan.hidden = false;
    hint("Stops picked", "Tap Plan route to walk first stop to last stop.");
    return;
  }
  phase = "review";
  els.summary.hidden = true;
  if (els.sheet) els.sheet.hidden = true;
  els.btnReview.hidden = true;
  els.btnPlan.hidden = false;
  const left = pending().length, total = candidates.length;
  if (adoptRestore && adoptRestore.targetId === place.id) {
    hint("Add this stop?", "❤️ keep the detour. ✕ cancel and go back.");
  } else {
    hint(`${total - left + 1} of ${total}`, "❤️ keep this stop. ✕ skip it.");
  }
  drawReviewPins();
  drawCatalog();
  const photo = place.photo_url || "placeholder.svg";
  const html = `<div class="spot-pop">
    <img src="${photo}" alt="">
    <div class="spot-pop-name">${place.name}</div>
    <div class="spot-pop-acts">
      <button type="button" class="emoji-btn" data-act="no">✕</button>
      <button type="button" class="emoji-btn" data-act="yes">❤️</button>
    </div>
  </div>`;
  reviewPopup = L.popup({
    closeButton: false,
    autoClose: false,
    closeOnClick: false,
    autoPan: false,
    className: "spot-popup",
    maxWidth: 200,
    offset: [0, -16],
  }).setLatLng([place.lat, place.lng]).setContent(html);

  const token = ++flyToken;
  const showPopup = () => {
    if (token !== flyToken) return;
    if (reviewCurrentId !== place.id) return;
    map.once("popupopen", () => {
      const node = reviewPopup && reviewPopup.getElement();
      if (!node) return;
      const yes = node.querySelector('[data-act="yes"]');
      const no = node.querySelector('[data-act="no"]');
      if (yes) yes.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        confirmReviewPlace(place, true);
      });
      if (no) no.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        confirmReviewPlace(place, false);
      });
    });
    reviewPopup.openOn(map);
  };

  if (reviewFirst) {
    reviewFirst = false;
    map.setView([place.lat, place.lng], 17.5, { animate: false });
    showPopup();
  } else {
    map.flyTo([place.lat, place.lng], 17.5, { animate: true, duration: 1, easeLinearity: 0.4 });
    map.once("moveend", showPopup);
  }
}
function refreshShape() {
  if (!start || !end) return;
  drawRubber();
  drawHandles();
  drawCatalog();
  if (phase === "done") return;
  closeReviewPopup();
  if (els.sheet) els.sheet.hidden = true;
  els.btnReview.hidden = false;
  els.btnPlan.hidden = true;
  hint("Shape the walk", "Pull the orange line onto spots or streets. When it looks right, tap Select stops.");
}
function hideSketch() {
  if (rubberLine) { map.removeLayer(rubberLine); rubberLine = null; }
  if (grabLine) { map.removeLayer(grabLine); grabLine = null; }
}
function openDoneCard(place) {
  closeReviewPopup();
  const onWalk = plannedStops.some((p) => p.id === place.id);
  const photo = place.photo_url || "placeholder.svg";
  const html = `<div class="spot-pop">
    <img src="${photo}" alt="">
    <div class="spot-pop-name">${place.name}</div>
    <p class="spot-pop-liner">${place.one_liner || ""}</p>
    <div class="spot-pop-acts">
      <button type="button" class="emoji-btn" data-act="no">✕</button>
      ${onWalk ? "" : `<button type="button" class="emoji-btn" data-act="yes">❤️</button>`}
    </div>
  </div>`;
  reviewPopup = L.popup({
    closeButton: false,
    autoClose: true,
    closeOnClick: true,
    autoPan: true,
    className: "spot-popup",
    maxWidth: 200,
    offset: [0, -16],
  }).setLatLng([place.lat, place.lng]).setContent(html);
  map.once("popupopen", () => {
    const node = reviewPopup && reviewPopup.getElement();
    if (!node) return;
    const no = node.querySelector('[data-act="no"]');
    const yes = node.querySelector('[data-act="yes"]');
    if (no) no.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      closeReviewPopup();
    });
    if (yes) yes.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      void addPlaceToPlannedWalk(place);
    });
  });
  reviewPopup.openOn(map);
}
async function applyPlannedLine(named, opts) {
  const reorder = !opts || opts.reorder !== false;
  const ordered = reorder ? orderStops(named) : named.slice();
  const line = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const raw = await stitch([entranceOf(ordered[i]), entranceOf(ordered[i + 1])]);
    if (!raw || raw.length < 2) throw new Error("leg");
    const leg = stripLoops(raw, [ordered[i], ordered[i + 1]]);
    if (line.length) line.push(...leg.slice(1));
    else line.push(...leg);
  }
  const cleaned = line;
  if (streetLayer) map.removeLayer(streetLayer);
  spurLayer.clearLayers();
  streetLayer = L.polyline(cleaned.map((p) => [p.lat, p.lng]), {
    color: "#2f5d4e", weight: 5, opacity: 0.9, interactive: false,
  }).addTo(map);
  ordered.forEach((p) => {
    const door = entranceOf(p);
    if (haversine(door, p) < 12) return;
    L.polyline([[door.lat, door.lng], [p.lat, p.lng]], {
      color: "#2f5d4e", weight: 3, opacity: 0.85, dashArray: "6 8", interactive: false,
    }).addTo(spurLayer);
  });
  plannedStops = ordered;
  drawCatalog();
}
async function addPlaceToPlannedWalk(place) {
  if (plannedStops.some((p) => p.id === place.id)) {
    closeReviewPopup();
    return;
  }
  closeReviewPopup();
  toast("Adding " + place.name + " to the walk.");
  try {
    await applyPlannedLine(insertStop(plannedStops, place), { reorder: false });
  } catch {
    toast("Could not add that stop to the walk.");
  }
}
function startSelecting() {
  if (!start || !end) return;
  reviewFirst = true;
  adoptRestore = null;
  focusPlaceId = null;
  rebuildCandidates();
  els.btnReview.hidden = true;
  els.btnPlan.hidden = false;
  if (!candidates.length) {
    hint("No extra stops", "Snap or Yes at least two spots, then Plan route.");
    return;
  }
  openCard();
}
async function planRoute() {
  if (!start || !end) return;
  const extra = yeses();
  const named = [];
  const seen = new Set();
  waypoints.forEach((wp) => {
    if (wp.place && !seen.has(wp.place.id)) { seen.add(wp.place.id); named.push(wp.place); }
  });
  extra.forEach((p) => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    named.push(p);
  });
  if (named.length < 2) {
    toast("Pick at least two stops before planning.");
    hint("Need two stops", "Yes at least two spots, or snap the line onto two pins, then Plan route.");
    els.btnPlan.hidden = false;
    return;
  }
  pending().forEach((p) => { p.verdict = "no"; });
  closeReviewPopup();
  if (els.sheet) els.sheet.hidden = true;
  els.btnPlan.hidden = true;
  hint("Planning the walk", "Ordering stops, then walking street to street.");
  hideSketch();
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
  pinLayer.clearLayers();
  handleLayer.clearLayers();
  spurLayer.clearLayers();
  phase = "done";
  try {
    await applyPlannedLine(named);
    map.fitBounds(streetLayer.getBounds(), { padding: [48, 48] });
    els.hint.hidden = true;
    if (els.summary) els.summary.hidden = true;
  } catch {
    els.btnPlan.hidden = false;
    toast("Could not plan that walk. Try two stops farther apart.");
  }
}

async function init() {
  map = L.map("map", { zoomControl: false }).setView([40.7225, -74.0005], 14);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19, attribution: "&copy; OSM &copy; CARTO",
  }).addTo(map);
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
  map.on("mousemove", (e) => {
    if (!pullingWp) return;
    pullingWp.lat = e.latlng.lat;
    pullingWp.lng = e.latlng.lng;
    drawRubber();
  });
  map.on("mouseup", finishPull);
  document.addEventListener("mouseup", finishPull);
  document.addEventListener("touchend", finishPull);

  map.on("click", (e) => {
    if (dragging) return;
    if (phase === "done" || phase === "review" || phase === "shaping") return;
    const { lat, lng } = e.latlng;
    if (!inZone(lat, lng)) { toast("MVP only works south of 23rd Street, on Manhattan."); return; }
    if (!start) {
      start = { lat, lng };
      startMarker = L.marker([lat, lng], { icon: abIcon("A", "#2f5d4e"), draggable: true }).addTo(map);
      startMarker.on("dragend", (ev) => {
        const ll = ev.target.getLatLng();
        if (!inZone(ll.lat, ll.lng)) { toast("Start must stay in the wash."); startMarker.setLatLng([start.lat, start.lng]); return; }
        start = { lat: ll.lat, lng: ll.lng };
        if (end) refreshShape();
      });
      els.btnClear.hidden = false;
      phase = "end";
      hint("Start is set", "Tap your end point.");
      return;
    }
    if (!end) {
      if (haversine(start, { lat, lng }) < 40) { toast("End is too close to start."); return; }
      end = { lat, lng };
      endMarker = L.marker([lat, lng], { icon: abIcon("B", "#1c1b18"), draggable: true }).addTo(map);
      endMarker.on("dragend", (ev) => {
        const ll = ev.target.getLatLng();
        if (!inZone(ll.lat, ll.lng)) { toast("End must stay in the wash."); endMarker.setLatLng([end.lat, end.lng]); return; }
        end = { lat: ll.lat, lng: ll.lng };
        refreshShape();
      });
      phase = "shaping";
      els.btnReview.hidden = false;
      hint("Pull the line", "Drag the orange line onto a spot or a street. Then tap Select stops.");
      drawRubber();
      refreshShape();
    }
  });

  els.btnClear.addEventListener("click", () => location.reload());
  els.btnReview.addEventListener("click", startSelecting);
  els.btnPlan.addEventListener("click", () => void planRoute());
}

init().catch(() => hint("Could not load places", "Make sure places.json sits next to this page."));
