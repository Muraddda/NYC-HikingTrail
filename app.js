const ZONE = {
  north: 40.7155,
  south: 40.6985,
  west: -74.0205,
  east: -73.9965,
};

const CORRIDOR_M = 150;
const MAX_YES = 5;
const OSRM = "https://router.project-osrm.org/route/v1/foot/";

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
  summary: document.getElementById("summary"),
  summaryBody: document.getElementById("summary-body"),
};

let map;
let places = [];
let start = null;
let end = null;
let startMarker = null;
let endMarker = null;
let routeLine = null;
let finalLine = null;
let originalLine = null;
let candidates = [];
let hiddenDots = [];
let pinLayer = L.layerGroup();
let dotLayer = L.layerGroup();
let cardIndex = 0;
let rejectedStack = [];
let phase = "idle";
let toastTimer = null;

function inZone(lat, lng) {
  return lat <= ZONE.north && lat >= ZONE.south && lng >= ZONE.west && lng <= ZONE.east;
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
  const toXY = (pt) => {
    const x = ((pt.lng - a.lng) * Math.PI) / 180 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    const y = ((pt.lat - a.lat) * Math.PI) / 180;
    return { x, y };
  };
  const A = { x: 0, y: 0 };
  const B = toXY(b);
  const P = toXY(p);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const lat = a.lat + t * (b.lat - a.lat);
  const lng = a.lng + t * (b.lng - a.lng);
  return { lat, lng, t };
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

function markerIcon(kind, label) {
  if (kind === "num") {
    return L.divIcon({
      className: "",
      html: `<div class="pin-label">${label}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }
  const color = kind === "start" ? "#2f5d4e" : "#1c1b18";
  const letter = kind === "start" ? "A" : "B";
  return L.divIcon({
    className: "",
    html: `<div class="pin-label" style="background:${color}">${letter}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function placeDot(place) {
  return L.circleMarker([place.lat, place.lng], {
    radius: 3.5,
    color: "#8a8478",
    weight: 0,
    fillColor: "#8a8478",
    fillOpacity: 0.85,
    interactive: false,
  });
}

function placePin(place, selected) {
  return L.circleMarker([place.lat, place.lng], {
    radius: selected ? 8 : 7,
    color: "#f3efe6",
    weight: 2,
    fillColor: selected ? "#2f5d4e" : "#c45c26",
    fillOpacity: 1,
    interactive: false,
  });
}

function resetMapLayers() {
  pinLayer.clearLayers();
  dotLayer.clearLayers();
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
  if (finalLine) {
    map.removeLayer(finalLine);
    finalLine = null;
  }
}

function clearAll() {
  start = null;
  end = null;
  originalLine = null;
  candidates = [];
  hiddenDots = [];
  cardIndex = 0;
  rejectedStack = [];
  phase = "idle";
  if (startMarker) {
    map.removeLayer(startMarker);
    startMarker = null;
  }
  if (endMarker) {
    map.removeLayer(endMarker);
    endMarker = null;
  }
  resetMapLayers();
  els.sheet.hidden = true;
  els.summary.hidden = true;
  els.btnClear.hidden = true;
  showHint("Tap the map", "First tap is your start. Second tap is your end. Both must sit south of Chambers Street.");
}

async function fetchRoute(points) {
  const path = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${OSRM}${path}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("router");
  const data = await res.json();
  if (!data.routes || !data.routes[0]) throw new Error("no-route");
  return data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

function drawRoute(line, color, weight) {
  return L.polyline(
    line.map((p) => [p.lat, p.lng]),
    { color, weight, opacity: 0.92, lineJoin: "round" }
  ).addTo(map);
}

function splitPlaces(line) {
  const near = [];
  const far = [];
  for (const place of places) {
    const { distance, along } = distanceToLine(
      { lat: place.lat, lng: place.lng },
      line
    );
    if (distance <= CORRIDOR_M) {
      near.push({ ...place, distance, along, verdict: "pending" });
    } else {
      far.push(place);
    }
  }
  near.sort((a, b) => a.along - b.along);
  return { near, far };
}

function drawHiddenDots() {
  dotLayer.clearLayers();
  hiddenDots.forEach((place) => placeDot(place).addTo(dotLayer));
}

function drawCandidatePins() {
  pinLayer.clearLayers();
  candidates.forEach((place) => {
    if (place.verdict === "no") return;
    const selected = place.verdict === "yes";
    placePin(place, selected).addTo(pinLayer);
  });
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

function updateYesButton() {
  const atCap = yeses().length >= MAX_YES;
  els.btnYes.disabled = atCap;
  els.btnYes.textContent = atCap ? "Cap reached" : "Yes — stop here";
}

function openCard() {
  const place = currentCard();
  if (!place) {
    finishReview();
    return;
  }
  phase = "review";
  hideHint();
  els.summary.hidden = true;
  els.sheet.hidden = false;
  const left = pending().length;
  const total = candidates.length;
  const answered = total - left;
  els.sheetCount.textContent = `${answered + 1} of ${total}`;
  els.sheetYes.textContent = `${yeses().length} / ${MAX_YES} stops`;
  els.placeName.textContent = place.name;
  els.placeBucket.textContent = place.category;
  els.placeLiner.textContent = place.one_liner;
  els.placeLink.href = place.source_url;
  els.btnUndo.hidden = rejectedStack.length === 0;
  updateYesButton();
  drawCandidatePins();
  map.panTo([place.lat, place.lng], { animate: true });
}

function decide(verdict) {
  const place = currentCard();
  if (!place) return;
  if (verdict === "yes" && yeses().length >= MAX_YES) return;
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
  hideHint();

  pinLayer.clearLayers();
  const stops = yeses();

  try {
    const pts = [start, ...stops.map((s) => ({ lat: s.lat, lng: s.lng })), end];
    const line = pts.length === 2 ? originalLine : await fetchRoute(pts);
    if (finalLine) map.removeLayer(finalLine);
    if (routeLine) map.removeLayer(routeLine);
    routeLine = null;
    finalLine = drawRoute(line, "#2f5d4e", 5);
    map.fitBounds(finalLine.getBounds(), { padding: [50, 160] });
  } catch (err) {
    toast("Could not rebuild the walk. Showing your original route.");
  }

  stops.forEach((place, i) => {
    L.marker([place.lat, place.lng], { icon: markerIcon("num", String(i + 1)), interactive: false }).addTo(pinLayer);
  });

  els.summary.hidden = false;
  if (stops.length === 0) {
    els.summaryBody.innerHTML = `<p class="empty">No stops. You still have the walk from A to B.</p>`;
  } else {
    els.summaryBody.innerHTML = `<ol>${stops
      .map((s) => `<li><strong>${s.name}</strong> — ${s.one_liner}</li>`)
      .join("")}</ol>`;
  }
}

async function buildWalk() {
  phase = "routing";
  showHint("Drawing the walk", "Finding a street route, then only the places within 150 meters.");
  try {
    const line = await fetchRoute([start, end]);
    originalLine = line;
    if (routeLine) map.removeLayer(routeLine);
    routeLine = drawRoute(line, "#c45c26", 5);
    map.fitBounds(routeLine.getBounds(), { padding: [40, 140] });

    const split = splitPlaces(line);
    candidates = split.near;
    hiddenDots = split.far;
    drawHiddenDots();

    if (candidates.length === 0) {
      phase = "done";
      hideHint();
      els.summary.hidden = false;
      els.summaryBody.innerHTML = `<p class="empty">Nothing in the 150 m corridor. The walk is still on the map. Clear and try a longer line through FiDi.</p>`;
      return;
    }
    openCard();
  } catch (err) {
    phase = "end";
    showHint("Route failed", "The free walking server did not answer. Tap Clear and try once more.");
    toast("Walking router is busy. Try again.");
  }
}

function onMapTap(e) {
  if (phase === "review" || phase === "done" || phase === "routing") return;
  const { lat, lng } = e.latlng;
  if (!inZone(lat, lng)) {
    toast("MVP only works south of Chambers Street, on Manhattan.");
    return;
  }
  if (!start) {
    start = { lat, lng };
    startMarker = L.marker([lat, lng], { icon: markerIcon("start"), interactive: false }).addTo(map);
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
    endMarker = L.marker([lat, lng], { icon: markerIcon("end"), interactive: false }).addTo(map);
    buildWalk();
  }
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
  pinLayer.addTo(map);
  dotLayer.addTo(map);

  const bounds = L.latLngBounds(
    [ZONE.south, ZONE.west],
    [ZONE.north, ZONE.east]
  );
  L.rectangle(bounds, {
    color: "#1c1b18",
    weight: 1,
    dashArray: "4 6",
    fill: false,
    opacity: 0.25,
    interactive: false,
  }).addTo(map);

  const res = await fetch("places.json");
  const data = await res.json();
  places = data.places.filter((p) => inZone(p.lat, p.lng));

  map.on("click", onMapTap);
  els.btnClear.addEventListener("click", clearAll);
  els.btnYes.addEventListener("click", () => decide("yes"));
  els.btnNo.addEventListener("click", () => decide("no"));
  els.btnDone.addEventListener("click", finishReview);
  els.btnUndo.addEventListener("click", undoNo);

  clearAll();
}

init().catch(() => {
  showHint("Could not load places", "Make sure places.json sits next to this page.");
});
