const CORRIDOR_M = 150;
const SNAP_M = 80;
const MAX_YES = 5;
const USE_CAP = false;
const OSRM = "https://router.project-osrm.org/route/v1/foot/";

const ZONE_POLY = [
  [40.7155, -74.0178],
  [40.7155, -74.0012],
  [40.7128, -73.9978],
  [40.7088, -73.9968],
  [40.7048, -73.9976],
  [40.7016, -74.0008],
  [40.7004, -74.0088],
  [40.7006, -74.0168],
  [40.7034, -74.0188],
  [40.7078, -74.0186],
  [40.7120, -74.0176],
];

const els = {
  hint: document.getElementById("hint"),
  hintTitle: document.getElementById("hint-title"),
  hintBody: document.getElementById("hint-body"),
  toast: document.getElementById("toast"),
  sheet: document.getElementById("sheet"),
  sheetCount: document.getElementById("sheet-count"),
  sheetYes: document.getElementById("sheet-yes"),
  placeName: document.getElementById("place-name"),
  placeBucket: document.getElementById("place-bucket"),
  placeLiner: document.getElementById("place-liner"),
  placeLink: document.getElementById("place-link"),
  btnYes: document.getElementById("btn-yes"),
  btnNo: document.getElementById("btn-no"),
  btnDone: document.getElementById("btn-done"),
  btnUndo: document.getElementById("btn-undo"),
  btnClear: document.getElementById("btn-clear"),
  btnReview: document.getElementById("btn-review"),
  summary: document.getElementById("summary"),
  summaryBody: document.getElementById("summary-body"),
};

let map;
let places = [];
let start = null;
let end = null;
let startMarker = null;
let endMarker = null;
let waypoints = [];
let rubberLine = null;
let grabLine = null;
let streetLine = null;
let streetLayer = null;
let catalogLayer = L.layerGroup();
let pinLayer = L.layerGroup();
let handleLayer = L.layerGroup();
let candidates = [];
let rejectedStack = [];
let phase = "idle";
let toastTimer = null;
let restitchTimer = null;
let dragging = false;

function pointInPoly(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1];
    const yj = poly[j][0], xj = poly[j][1];
    const inter = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (inter) inside = !inside;
  }
  return inside;
}

function inZone(lat, lng) {
  return pointInPoly(lat, lng, ZONE_POLY);
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function projectOnSegment(p, a, b) {
  const midLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const ax = 0;
  const ay = 0;
  const bx = (b.lng - a.lng) * Math.cos(midLat);
  const by = b.lat - a.lat;
  const px = (p.lng - a.lng) * Math.cos(midLat);
  const py = p.lat - a.lat;
  const len2 = bx * bx + by * by;
  let t = len2 === 0 ? 0 : (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return {
    lat: a.lat + t * (b.lat - a.lat),
    lng: a.lng + t * (b.lng - a.lng),
    t,
  };
}

function distanceToLine(point, line) {
  let best = Infinity;
  let along = 0;
  let walked = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const proj = projectOnSegment(point, a, b);
    const d = haversine(point, proj);
    if (d < best) {
      best = d;
      along = walked + haversine(a, proj);
    }
    walked += haversine(a, b);
  }
  return { distance: best, along };
}

function closestOnLine(point, line) {
  let best = { distance: Infinity, index: 0, lat: point.lat, lng: point.lng };
  for (let i = 0; i < line.length - 1; i++) {
    const proj = projectOnSegment(point, line[i], line[i + 1]);
    const d = haversine(point, proj);
    if (d < best.distance) best = { distance: d, index: i, lat: proj.lat, lng: proj.lng };
  }
  return best;
}

function axisT(p) {
  if (!start || !end) return 0;
  const midLat = ((start.lat + end.lat) / 2) * Math.PI / 180;
  const vx = (end.lng - start.lng) * Math.cos(midLat);
  const vy = end.lat - start.lat;
  const wx = (p.lng - start.lng) * Math.cos(midLat);
  const wy = p.lat - start.lat;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return 0;
  return (wx * vx + wy * vy) / len2;
}

function sortWaypoints() {
  waypoints.sort((a, b) => axisT(a) - axisT(b));
}

function showHint(title, body) {
  els.hint.hidden = false;
  els.hintTitle.textContent = title;
  els.hintBody.textContent = body;
}

function hideHint() {
  els.hint.hidden = true;
}

function toast(msg) {
  els.toast.hidden = false;
  els.toast.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

function abIcon(letter, color) {
  return L.divIcon({
    className: "",
    html: `<div class="pin-label" style="background:${color}">${letter}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function handleIcon(wp) {
  if (wp.place) {
    return L.divIcon({
      className: "",
      html: `<div class="wp-wrap"><div class="wp-name">${wp.place.name}</div><div class="pin-label" style="background:#c45c26">●</div></div>`,
      iconSize: [180, 48],
      iconAnchor: [90, 36],
    });
  }
  return L.divIcon({
    className: "",
    html: `<div class="pin-label" style="background:#c45c26">+</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function activeIcon() {
  return L.divIcon({
    className: "",
    html: `<div class="active-ring"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function nearestPlace(pt) {
  let best = null;
  let bestD = SNAP_M;
  for (const place of places) {
    const d = haversine(pt, place);
    if (d <= bestD) {
      best = place;
      bestD = d;
    }
  }
  return best;
}

function snappedIds() {
  const ids = new Set();
  waypoints.forEach((wp) => {
    if (wp.place) ids.add(wp.place.id);
  });
  return ids;
}

function controlPoints() {
  const pts = [];
  if (start) pts.push(start);
  waypoints.forEach((wp) => pts.push({ lat: wp.lat, lng: wp.lng }));
  if (end) pts.push(end);
  return pts;
}

function drawRubber() {
  const pts = controlPoints();
  const latlngs = pts.map((p) => [p.lat, p.lng]);
  if (rubberLine) rubberLine.setLatLngs(latlngs);
  else {
    rubberLine = L.polyline(latlngs, {
      color: "#c45c26",
      weight: 4,
      opacity: 0.95,
      interactive: false,
    }).addTo(map);
  }
  if (grabLine) grabLine.setLatLngs(latlngs);
  else {
    grabLine = L.polyline(latlngs, {
      color: "#c45c26",
      weight: 28,
      opacity: 0.001,
      interactive: true,
    }).addTo(map);
    grabLine.on("click", onGrabLine);
  }
}

function drawHandles() {
  handleLayer.clearLayers();
  waypoints.forEach((wp) => {
    const marker = L.marker([wp.lat, wp.lng], {
      icon: handleIcon(wp),
      draggable: true,
      autoPan: true,
    }).addTo(handleLayer);
    marker.on("dragstart", () => {
      dragging = true;
    });
    marker.on("drag", (e) => {
      const ll = e.target.getLatLng();
      const place = nearestPlace({ lat: ll.lat, lng: ll.lng });
      if (place) {
        wp.lat = place.lat;
        wp.lng = place.lng;
        wp.place = place;
        e.target.setLatLng([place.lat, place.lng]);
        e.target.setIcon(handleIcon(wp));
      } else {
        wp.lat = ll.lat;
        wp.lng = ll.lng;
        wp.place = null;
        e.target.setIcon(handleIcon(wp));
      }
      drawRubber();
    });
    marker.on("dragend", (e) => {
      const ll = e.target.getLatLng();
      finishWaypointMove(wp, { lat: ll.lat, lng: ll.lng });
      dragging = false;
    });
    marker.on("click", (e) => {
      L.DomEvent.stop(e);
      removeWaypoint(wp);
    });
  });
}

function catalogStyle(place) {
  const snapped = snappedIds().has(place.id);
  return {
    radius: snapped ? 8 : 5.5,
    color: "#f3efe6",
    weight: 2,
    fillColor: snapped ? "#c45c26" : "#1c1b18",
    fillOpacity: 0.95,
  };
}

function drawCatalog() {
  catalogLayer.clearLayers();
  places.forEach((place) => {
    L.circleMarker([place.lat, place.lng], {
      ...catalogStyle(place),
      interactive: false,
    }).addTo(catalogLayer);
  });
}

function lineLeavesZone(line) {
  let outside = 0;
  line.forEach((p) => {
    if (!inZone(p.lat, p.lng)) outside += 1;
  });
  return outside > Math.max(3, line.length * 0.12);
}

async function fetchLeg(a, b) {
  const url = `${OSRM}${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&exclude=ferry`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("router");
  const data = await res.json();
  if (!data.routes || !data.routes[0]) throw new Error("no-route");
  return data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

async function stitch(points) {
  if (points.length < 2) return [];
  const merged = [];
  for (let i = 0; i < points.length - 1; i++) {
    const leg = await fetchLeg(points[i], points[i + 1]);
    if (lineLeavesZone(leg)) throw new Error("off-island");
    if (i === 0) merged.push(...leg);
    else merged.push(...leg.slice(1));
  }
  return merged;
}

function drawStreet(line, color) {
  if (streetLayer) {
    map.removeLayer(streetLayer);
    streetLayer = null;
  }
  if (!line || line.length < 2) return;
  streetLayer = L.polyline(
    line.map((p) => [p.lat, p.lng]),
    { color, weight: 5, opacity: 0.9, lineJoin: "round", interactive: false }
  ).addTo(map);
}

function pending() {
  return candidates.filter((p) => p.verdict === "pending");
}

function yeses() {
  return candidates.filter((p) => p.verdict === "yes");
}

function currentCard() {
  return pending()[0] || null;
}

function rebuildCandidates() {
  if (!streetLine || streetLine.length < 2) return;
  const skip = snappedIds();
  const prev = new Map(candidates.map((c) => [c.id, c.verdict]));
  const near = [];
  places.forEach((place) => {
    if (skip.has(place.id)) return;
    const { distance, along } = distanceToLine(place, streetLine);
    if (distance <= CORRIDOR_M) {
      near.push({
        ...place,
        distance,
        along,
        verdict: prev.get(place.id) || "pending",
      });
    }
  });
  near.sort((a, b) => a.along - b.along);
  candidates = near;
}

function drawReviewPins() {
  pinLayer.clearLayers();
  const current = currentCard();
  candidates.forEach((place) => {
    if (place.verdict === "no") return;
    if (current && place.id === current.id) {
      L.marker([place.lat, place.lng], { icon: activeIcon(), interactive: false }).addTo(pinLayer);
      L.marker([place.lat, place.lng], {
        icon: L.divIcon({
          className: "",
          html: `<div class="wp-name">${place.name}</div>`,
          iconSize: [0, 0],
          iconAnchor: [0, 18],
        }),
        interactive: false,
      }).addTo(pinLayer);
    } else if (place.verdict === "yes") {
      L.circleMarker([place.lat, place.lng], {
        radius: 8,
        color: "#f3efe6",
        weight: 2,
        fillColor: "#2f5d4e",
        fillOpacity: 1,
        interactive: false,
      }).addTo(pinLayer);
    } else {
      L.circleMarker([place.lat, place.lng], {
        radius: 7,
        color: "#f3efe6",
        weight: 2,
        fillColor: "#c45c26",
        fillOpacity: 1,
        interactive: false,
      }).addTo(pinLayer);
    }
  });
}

function openCard() {
  const place = currentCard();
  if (!place) {
    if (phase !== "done") finishReview();
    return;
  }
  phase = "review";
  hideHint();
  els.summary.hidden = true;
  els.sheet.hidden = false;
  if (els.btnReview) els.btnReview.hidden = true;
  const left = pending().length;
  const total = candidates.length;
  els.sheetCount.textContent = `${total - left + 1} of ${total}`;
  els.sheetYes.textContent = `${yeses().length} extra stop${yeses().length === 1 ? "" : "s"}`;
  els.placeName.textContent = place.name;
  els.placeBucket.textContent = place.category;
  els.placeLiner.textContent = place.one_liner;
  els.placeLink.href = place.source_url;
  els.btnUndo.hidden = rejectedStack.length === 0;
  if (USE_CAP && yeses().length >= MAX_YES) {
    els.btnYes.disabled = true;
    els.btnYes.textContent = "Cap reached";
  } else {
    els.btnYes.disabled = false;
    els.btnYes.textContent = "Yes — stop here";
  }
  drawReviewPins();
  const sheetH = els.sheet.getBoundingClientRect().height || 220;
  map.panTo([place.lat, place.lng], { animate: true });
  setTimeout(() => {
    map.panBy([0, sheetH / 2 - 40], { animate: true });
  }, 220);
}

function decide(verdict) {
  const place = currentCard();
  if (!place) return;
  if (verdict === "yes" && USE_CAP && yeses().length >= MAX_YES) return;
  place.verdict = verdict;
  if (verdict === "no") rejectedStack.push(place.id);
  openCard();
}

function undoNo() {
  const id = rejectedStack.pop();
  if (!id) return;
  const place = candidates.find((p) => p.id === id);
  if (place) place.verdict = "pending";
  openCard();
}

async function finishReview() {
  pending().forEach((p) => {
    p.verdict = "no";
  });
  phase = "done";
  els.sheet.hidden = true;
  if (els.btnReview) els.btnReview.hidden = true;
  hideHint();
  pinLayer.clearLayers();

  const extra = yeses();
  const have = snappedIds();
  extra.forEach((p) => {
    if (have.has(p.id)) return;
    waypoints.push({ lat: p.lat, lng: p.lng, place: p, id: "yes-" + p.id });
  });
  sortWaypoints();
  drawHandles();
  drawRubber();
  drawCatalog();

  try {
    streetLine = await stitch(controlPoints());
    drawStreet(streetLine, "#2f5d4e");
    if (streetLayer) map.fitBounds(streetLayer.getBounds(), { padding: [50, 160] });
  } catch (err) {
    toast("Could not rebuild a Manhattan-only walk. Move a handle and try Done again.");
  }

  const named = [
    ...waypoints.filter((wp) => wp.place).map((wp) => wp.place),
  ];
  const seen = new Set();
  const stops = [];
  named.forEach((p) => {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      stops.push(p);
    }
  });

  els.summary.hidden = false;
  if (stops.length === 0) {
    els.summaryBody.innerHTML = `<p class="empty">No named stops. You still have the street walk from A to B.</p>`;
  } else {
    els.summaryBody.innerHTML = `<ol>${stops
      .map((s) => `<li><strong>${s.name}</strong> — ${s.one_liner}</li>`)
      .join("")}</ol>`;
  }
}

async function restitchAndCards() {
  if (!start || !end) return;
  sortWaypoints();
  drawRubber();
  drawHandles();
  drawCatalog();
  try {
    streetLine = await stitch(controlPoints());
    drawStreet(streetLine, "#c45c26");
    rebuildCandidates();
    if (phase === "done") return;
    els.sheet.hidden = true;
    if (els.btnReview) els.btnReview.hidden = false;
    showHint(
      "Shape the walk",
      candidates.length
        ? "Pull the line onto spots or streets. When it looks right, tap Select stops."
        : "Pull the line onto spots or streets. Select stops when you are ready."
    );
  } catch (err) {
    if (err.message === "off-island") {
      toast("That pull left Manhattan. Handle snapped back.");
    } else {
      toast("Walking router is busy. Try the pull again.");
    }
  }
}

function scheduleRestitch() {
  clearTimeout(restitchTimer);
  restitchTimer = setTimeout(restitchAndCards, 80);
}

function startSelecting() {
  if (!start || !end) return;
  rebuildCandidates();
  if (!streetLine || candidates.length === 0) {
    toast("No extra stops within 150 m of this walk. Your waypoints are the route.");
    finishReview();
    return;
  }
  if (els.btnReview) els.btnReview.hidden = true;
  openCard();
}

function finishWaypointMove(wp, pt) {
  if (!inZone(pt.lat, pt.lng)) {
    toast("Stay south of Chambers, on Manhattan.");
    removeWaypoint(wp);
    return;
  }
  const place = nearestPlace(pt);
  if (place) {
    wp.lat = place.lat;
    wp.lng = place.lng;
    wp.place = place;
  } else {
    wp.lat = pt.lat;
    wp.lng = pt.lng;
    wp.place = null;
  }
  scheduleRestitch();
}

function addWaypointAt(pt, afterIndex) {
  const place = nearestPlace(pt);
  const wp = place
    ? { lat: place.lat, lng: place.lng, place, id: "wp-" + Date.now() }
    : { lat: pt.lat, lng: pt.lng, place: null, id: "wp-" + Date.now() };
  waypoints.push(wp);
  sortWaypoints();
  scheduleRestitch();
}

function removeWaypoint(wp) {
  waypoints = waypoints.filter((w) => w.id !== wp.id);
  scheduleRestitch();
}

function onGrabLine(e) {
  if (phase === "done" || phase === "idle" || !start || !end) return;
  L.DomEvent.stop(e);
  const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
  if (!inZone(pt.lat, pt.lng)) {
    toast("Stay south of Chambers, on Manhattan.");
    return;
  }
  addWaypointAt(pt);
}

function onMapTap(e) {
  if (dragging) return;
  if (phase === "done") return;
  if (phase === "review" || phase === "shaping") return;
  const { lat, lng } = e.latlng;
  if (!inZone(lat, lng)) {
    toast("MVP only works south of Chambers Street, on Manhattan.");
    return;
  }
  if (!start) {
    start = { lat, lng };
    startMarker = L.marker([lat, lng], {
      icon: abIcon("A", "#2f5d4e"),
      draggable: true,
    }).addTo(map);
    startMarker.on("dragend", (ev) => {
      const ll = ev.target.getLatLng();
      if (!inZone(ll.lat, ll.lng)) {
        toast("Start must stay in the wash.");
        startMarker.setLatLng([start.lat, start.lng]);
        return;
      }
      start = { lat: ll.lat, lng: ll.lng };
      if (end) scheduleRestitch();
    });
    els.btnClear.hidden = false;
    phase = "end";
    showHint("Start is set", "Tap your end point.");
    return;
  }
  if (!end) {
    end = { lat, lng };
    if (haversine(start, end) < 40) {
      toast("End is too close to start. Tap farther away.");
      end = null;
      return;
    }
    endMarker = L.marker([lat, lng], {
      icon: abIcon("B", "#1c1b18"),
      draggable: true,
    }).addTo(map);
    endMarker.on("dragend", (ev) => {
      const ll = ev.target.getLatLng();
      if (!inZone(ll.lat, ll.lng)) {
        toast("End must stay in the wash.");
        endMarker.setLatLng([end.lat, end.lng]);
        return;
      }
      end = { lat: ll.lat, lng: ll.lng };
      scheduleRestitch();
    });
    phase = "shaping";
    if (els.btnReview) els.btnReview.hidden = false;
    showHint("Pull the line", "Drag the orange line onto a spot or a street. Then tap Select stops.");
    drawRubber();
    scheduleRestitch();
  }
}

function clearAll() {
  start = null;
  end = null;
  waypoints = [];
  streetLine = null;
  candidates = [];
  rejectedStack = [];
  phase = "idle";
  dragging = false;
  if (startMarker) map.removeLayer(startMarker);
  if (endMarker) map.removeLayer(endMarker);
  if (rubberLine) map.removeLayer(rubberLine);
  if (grabLine) map.removeLayer(grabLine);
  if (streetLayer) map.removeLayer(streetLayer);
  startMarker = endMarker = rubberLine = grabLine = streetLayer = null;
  handleLayer.clearLayers();
  pinLayer.clearLayers();
  drawCatalog();
  els.sheet.hidden = true;
  els.summary.hidden = true;
  els.btnClear.hidden = true;
  if (els.btnReview) els.btnReview.hidden = true;
  showHint("Tap the map", "First tap is start. Second tap is end. Then pull the line through the blocks you want.");
}

async function init() {
  map = L.map("map", {
    zoomControl: false,
    attributionControl: true,
  }).setView([40.7072, -74.0105], 15);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "&copy; OSM &copy; CARTO",
  }).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  catalogLayer.addTo(map);
  pinLayer.addTo(map);
  handleLayer.addTo(map);

  L.polygon(ZONE_POLY, {
    color: "transparent",
    weight: 0,
    fillColor: "#2f5d4e",
    fillOpacity: 0.16,
    interactive: false,
  }).addTo(map);

  const res = await fetch("places.json");
  const data = await res.json();
  places = data.places.filter((p) => inZone(p.lat, p.lng));
  drawCatalog();

  map.on("click", onMapTap);
  els.btnClear.addEventListener("click", clearAll);
  if (els.btnReview) els.btnReview.addEventListener("click", startSelecting);
  els.btnYes.addEventListener("click", () => decide("yes"));
  els.btnNo.addEventListener("click", () => decide("no"));
  els.btnDone.addEventListener("click", finishReview);
  els.btnUndo.addEventListener("click", undoNo);

  clearAll();
}

init().catch(() => {
  showHint("Could not load places", "Make sure places.json sits next to this page.");
});
