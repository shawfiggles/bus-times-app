const pdfjsLib = window.pdfjsLib;

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";

const DB_NAME = "bus-times-app";
const DB_VERSION = 1;
const ROUTE_STORE = "routes";
const SETTINGS_STORE = "settings";
const LAST_ROUTE_KEY = "busTimes.lastRouteId";
const PARSER_VERSION = "2.0.0";
const TIME_RE = /\b(?:[01]\d|2[0-3]):[0-5]\d\b/g;
const DEFAULT_MAP_CENTER = { lat: 25.235612, lng: 55.297857 };
const REMINDER_MINUTES = [30, 20, 10, 5, 2];
const DEFAULT_COMMUTE_PREFS = {
  walkingSpeed: 75,
  bufferMinutes: 3,
  reminderMinutes: [10, 5, 2]
};
const PLACE_ALIASES = [
  {
    terms: ["al fattan park tower", "al fattan park view tower", "fattan park tower", "fattan park view"],
    name: "Al Fattan Park View Tower",
    address: "119 Sheikh Rashid Rd, Al Karama, Dubai",
    lat: 25.2371,
    lng: 55.2961
  },
  {
    terms: ["al shafar park tower", "shafar park tower", "al shafar park", "shafar park"],
    name: "Al Shafar Park Tower",
    address: "Al Shafar Park Tower, Al Karama, Dubai",
    lat: 25.2396566,
    lng: 55.2970575
  }
];

let db;

const state = {
  routes: [],
  settings: { stopLocationsByRoute: {}, lastStopByRoute: {} },
  activeRouteId: localStorage.getItem(LAST_ROUTE_KEY),
  activeStopIndex: 0,
  activeView: "home",
  pendingUpload: null,
  editingStopIndex: 0,
  editingRouteId: null,
  pickerPosition: { ...DEFAULT_MAP_CENTER },
  currentPosition: null,
  homeRenderKey: "",
  countdownText: ""
};

const els = {
  headerRoute: document.querySelector("#header-route"),
  homeRouteChip: document.querySelector("#home-route-chip"),
  homeUpdated: document.querySelector("#home-updated"),
  activeStopName: document.querySelector("#active-stop-name"),
  distanceReadout: document.querySelector("#distance-readout"),
  nextTime: document.querySelector("#next-time"),
  countdown: document.querySelector("#countdown"),
  countdownProgressFill: document.querySelector("#countdown-progress-fill"),
  commuteAdvice: document.querySelector("#commute-advice"),
  routeMap: document.querySelector("#route-map"),
  arrivalList: document.querySelector("#arrival-list"),
  stopSwitcher: document.querySelector("#stop-switcher"),
  locateButton: document.querySelector("#locate-button"),
  upcomingGrid: document.querySelector("#upcoming-grid"),
  routeList: document.querySelector("#route-list"),
  pdfInput: document.querySelector("#pdf-input"),
  uploadStatus: document.querySelector("#upload-status"),
  reviewCard: document.querySelector("#review-card"),
  reviewRouteName: document.querySelector("#review-route-name"),
  reviewEffectiveDate: document.querySelector("#review-effective-date"),
  reviewMeta: document.querySelector("#review-meta"),
  stopEditor: document.querySelector("#stop-editor"),
  saveMode: document.querySelector("#save-mode"),
  existingRouteSelect: document.querySelector("#existing-route-select"),
  sampleTable: document.querySelector("#sample-table"),
  saveUpload: document.querySelector("#save-upload"),
  cancelUpload: document.querySelector("#cancel-upload"),
  scheduleSummary: document.querySelector("#schedule-summary"),
  scheduleHead: document.querySelector("#schedule-head"),
  scheduleBody: document.querySelector("#schedule-body"),
  locationList: document.querySelector("#location-list"),
  locationSearchForm: document.querySelector("#location-search-form"),
  locationSearch: document.querySelector("#location-search"),
  searchResults: document.querySelector("#search-results"),
  tileGrid: document.querySelector("#tile-grid"),
  useCurrentLocation: document.querySelector("#use-current-location"),
  openMapLink: document.querySelector("#open-map-link"),
  latInput: document.querySelector("#lat-input"),
  lngInput: document.querySelector("#lng-input"),
  saveLocation: document.querySelector("#save-location"),
  clearLocation: document.querySelector("#clear-location"),
  settingsStatus: document.querySelector("#settings-status"),
  walkingSpeed: document.querySelector("#walking-speed"),
  bufferMinutes: document.querySelector("#buffer-minutes"),
  reminderThirty: document.querySelector("#reminder-thirty"),
  reminderTwenty: document.querySelector("#reminder-twenty"),
  reminderTen: document.querySelector("#reminder-ten"),
  reminderFive: document.querySelector("#reminder-five"),
  reminderTwo: document.querySelector("#reminder-two"),
  enableNotifications: document.querySelector("#enable-notifications"),
  notificationStatus: document.querySelector("#notification-status")
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ROUTE_STORE)) {
        database.createObjectStore(ROUTE_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const request = tx(store).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const request = tx(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const request = tx(store, "readwrite").put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const request = tx(store, "readwrite").delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function loadState() {
  db = await openDatabase();
  state.routes = (await idbGetAll(ROUTE_STORE)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const settingsRecord = await idbGet(SETTINGS_STORE, "app");
  state.settings = {
    stopLocationsByRoute: {},
    lastStopByRoute: {},
    commutePrefsByRoute: {},
    notificationPrefs: { enabled: false, permission: "default" },
    ...(settingsRecord?.value || {})
  };
  await migrateOldRoute07();

  if (!state.activeRouteId || !state.routes.some((route) => route.id === state.activeRouteId)) {
    state.activeRouteId = state.routes[0]?.id || null;
  }
  if (state.activeRouteId) {
    localStorage.setItem(LAST_ROUTE_KEY, state.activeRouteId);
  }
}

async function saveSettings() {
  await idbPut(SETTINGS_STORE, { key: "app", value: state.settings });
}

async function migrateOldRoute07() {
  const oldRows = readJSON("route07.timetable", null);
  const oldMeta = readJSON("route07.pdfMeta", null);
  if (!oldRows?.length || state.routes.some((route) => route.source?.legacyRoute07)) return;

  const route = {
    id: createId("route-7"),
    name: "Route 7",
    effectiveDate: "",
    fileName: oldMeta?.fileName || "Migrated Route 07",
    uploadedAt: oldMeta?.parsedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
    stops: [
      makeStop("EGHQ", 0),
      makeStop("Park Zabeel View 1", 1, "PZV1"),
      makeStop("Park Zabeel View 2", 2, "PZV2"),
      makeStop("EGHQ", 3)
    ],
    rows: oldRows.map((row) => [row.eghqDepart, row.pzv1, row.pzv2, row.eghqArrive]),
    source: { legacyRoute07: true }
  };
  await idbPut(ROUTE_STORE, route);
  state.routes.unshift(route);
}

function readJSON(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function createId(seed = "route") {
  return `${slug(seed)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function slug(value) {
  return String(value || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "item";
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/\[[^\]]+\]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function makeStop(name, index, shortName = "") {
  const cleanName = name.trim() || `Stop ${index + 1}`;
  return {
    id: `${slug(cleanName)}-${index}`,
    name: cleanName,
    shortName: shortName || cleanName.replace(/\s+/g, " ").slice(0, 12),
    index
  };
}

function activeRoute() {
  return state.routes.find((route) => route.id === state.activeRouteId) || null;
}

function departureStops(route = activeRoute()) {
  if (!route) return [];
  const last = lastItem(route.stops);
  const first = route.stops[0];
  if (last && first && normalizeName(last.name) === normalizeName(first.name)) {
    return route.stops.slice(0, -1);
  }
  return route.stops.slice(0, Math.max(1, route.stops.length - 1));
}

function timeToMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatDuration(minutes) {
  if (minutes <= 0) return "Due now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `in ${hours} hr ${remainder} min` : `in ${hours} hr`;
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "Now";
  const secondsTotal = Number(seconds);
  const hours = Math.floor(secondsTotal / 3600);
  const mins = Math.floor((secondsTotal % 3600) / 60);
  const secs = secondsTotal % 60;
  if (hours > 0) return `${hours}h ${mins}m ${String(secs).padStart(2, "0")}s`;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

function formatDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function lastItem(items) {
  return items[items.length - 1];
}

function getTimedRows(route, stopIndex, now = new Date()) {
  if (!route?.rows?.length) return [];
  const nowMs = now.getTime();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  return route.rows
    .filter((row) => row[stopIndex])
    .map((row, index) => {
      const base = timeToMinutes(row[stopIndex]);
      let targetAt = dayStart.getTime() + base * 60000;
      if (targetAt < nowMs) targetAt += 1440 * 60000;
      const minutes = Math.round((targetAt - dayStart.getTime()) / 60000);
      const waitSeconds = Math.max(0, Math.ceil((targetAt - nowMs) / 1000));
      const wait = Math.ceil(waitSeconds / 60);
      return { row, index, minutes, wait, waitSeconds, targetAt };
    })
    .sort((a, b) => a.minutes - b.minutes);
}

function normalizeArrival(row, fieldIndex, departureMinutes) {
  let minutes = timeToMinutes(row[fieldIndex]);
  while (minutes < departureMinutes) minutes += 1440;
  return minutes;
}

function locationBucket(routeId = state.activeRouteId) {
  if (!routeId) return {};
  if (!state.settings.stopLocationsByRoute[routeId]) state.settings.stopLocationsByRoute[routeId] = {};
  return state.settings.stopLocationsByRoute[routeId];
}

function getLastStopIndex(route) {
  if (!route) return 0;
  const stops = departureStops(route);
  const saved = state.settings.lastStopByRoute?.[route.id];
  return stops.some((stop) => stop.index === saved) ? saved : stops[0]?.index || 0;
}

async function rememberStop(routeId, stopIndex) {
  if (!routeId) return;
  if (!state.settings.lastStopByRoute) state.settings.lastStopByRoute = {};
  state.settings.lastStopByRoute[routeId] = stopIndex;
  await saveSettings();
}

function savedLocationCount(route) {
  if (!route) return { saved: 0, total: 0 };
  const bucket = locationBucket(route.id);
  const stops = departureStops(route);
  return {
    saved: stops.filter((stop) => bucket[stop.id]).length,
    total: stops.length
  };
}

function commutePrefs(routeId = state.activeRouteId) {
  if (!routeId) return { ...DEFAULT_COMMUTE_PREFS };
  if (!state.settings.commutePrefsByRoute) state.settings.commutePrefsByRoute = {};
  if (!state.settings.commutePrefsByRoute[routeId]) state.settings.commutePrefsByRoute[routeId] = cloneJson(DEFAULT_COMMUTE_PREFS);
  const prefs = state.settings.commutePrefsByRoute[routeId];
  if (!Array.isArray(prefs.reminderMinutes)) {
    const old = prefs.reminders || {};
    prefs.reminderMinutes = [
      old.thirty && 30,
      old.twenty && 20,
      old.ten && 10,
      (old.five || old.leave) && 5,
      (old.two || old.one) && 2
    ].filter(Boolean);
    if (!prefs.reminderMinutes.length) prefs.reminderMinutes = cloneJson(DEFAULT_COMMUTE_PREFS.reminderMinutes);
  }
  if (!prefs.walkingSpeed) prefs.walkingSpeed = DEFAULT_COMMUTE_PREFS.walkingSpeed;
  if (prefs.bufferMinutes === undefined) prefs.bufferMinutes = DEFAULT_COMMUTE_PREFS.bufferMinutes;
  return prefs;
}

function activeReminderMinutes(routeId = state.activeRouteId) {
  const prefs = commutePrefs(routeId);
  return REMINDER_MINUTES.filter((minute) => prefs.reminderMinutes?.includes(minute));
}

function commuteGuidance(route, stopIndex, next) {
  const prefs = commutePrefs(route?.id);
  const stop = route?.stops?.[stopIndex];
  const saved = stop ? locationBucket(route.id)[stop.id] : null;
  if (!route || !next || !saved || !state.currentPosition) {
    return {
      state: "Set location",
      title: "Set stop locations for leave-now guidance.",
      detail: "Use nearest stop once location access is allowed.",
      walkMinutes: null
    };
  }

  const meters = distanceInMeters(state.currentPosition, saved);
  const walkMinutes = Math.ceil(meters / Number(prefs.walkingSpeed || DEFAULT_COMMUTE_PREFS.walkingSpeed));
  const leaveIn = next.wait - walkMinutes - Number(prefs.bufferMinutes || 0);
  let stateLabel = "Plenty of time";
  let title = `Leave in ${formatDuration(leaveIn).replace("in ", "")}`;
  if (leaveIn <= -2) {
    stateLabel = "You may miss this";
    title = "Head out now or catch the next one.";
  } else if (leaveIn <= 0) {
    stateLabel = "Leave now";
    title = "Leave now.";
  } else if (leaveIn <= 5) {
    stateLabel = "Start walking";
    title = `Start walking in ${leaveIn} min.`;
  }

  return {
    state: stateLabel,
    title,
    detail: `${walkMinutes} min walk + ${prefs.bufferMinutes} min buffer.`,
    walkMinutes,
    leaveIn
  };
}

function renderAll() {
  renderShell();
  renderHome();
  renderRoutes();
  renderUploadReview();
  renderSchedule();
  renderSettings();
}

function renderShell() {
  const route = activeRoute();
  els.headerRoute.textContent = route?.name || "No route";
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.dataset.view === state.activeView);
  });
  document.querySelectorAll("[data-nav]").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === state.activeView);
  });
}

function renderHome() {
  const route = activeRoute();
  if (!route) {
    state.homeRenderKey = "";
    state.countdownText = "";
    document.body.dataset.homeState = "empty";
    els.homeRouteChip.textContent = "No route selected";
    els.homeUpdated.textContent = "Waiting for PDF";
    els.activeStopName.textContent = "--";
    els.distanceReadout.textContent = "Upload a route to begin";
    els.nextTime.textContent = "--:--";
    els.countdown.textContent = "Upload a route to begin";
    els.countdownProgressFill.style.width = "0%";
    els.commuteAdvice.innerHTML = `<strong>No route yet.</strong><span>Upload a PDF to start.</span>`;
    els.routeMap.innerHTML = "";
    els.arrivalList.innerHTML = "";
    els.stopSwitcher.innerHTML = "";
    els.upcomingGrid.innerHTML = emptyState("No upcoming buses yet.");
    return;
  }

  const stops = departureStops(route);
  if (!stops.some((stop) => stop.index === state.activeStopIndex)) {
    state.activeStopIndex = getLastStopIndex(route);
  }
  const activeStop = route.stops[state.activeStopIndex];
  const next = getTimedRows(route, state.activeStopIndex)[0];

  els.homeRouteChip.textContent = route.name;
  els.homeUpdated.textContent = route.effectiveDate || formatDate(route.updatedAt);
  els.activeStopName.textContent = activeStop?.shortName || activeStop?.name || "--";

  if (!next) {
    state.homeRenderKey = "";
    state.countdownText = "";
    document.body.dataset.homeState = "empty";
    els.nextTime.textContent = "--:--";
    els.countdown.textContent = "No times found for this stop";
    els.countdownProgressFill.style.width = "0%";
    els.commuteAdvice.innerHTML = `<strong>No departure found.</strong><span>Try another stop or update the PDF.</span>`;
    els.routeMap.innerHTML = renderRouteMap(route);
    els.arrivalList.innerHTML = "";
    els.stopSwitcher.innerHTML = stops.map((stop) => `
      <button class="${stop.index === state.activeStopIndex ? "active" : ""}" type="button" data-stop-index="${stop.index}">
        ${escapeHTML(stop.shortName || stop.name)}
      </button>
    `).join("");
    els.upcomingGrid.innerHTML = emptyState("No departures found.");
    return;
  }

  els.nextTime.textContent = next.row[state.activeStopIndex];
  document.body.dataset.homeState = next.waitSeconds <= 600 ? "soon" : "calm";
  const countdownText = formatCountdown(next.waitSeconds);
  if (state.countdownText !== countdownText) {
    state.countdownText = countdownText;
    els.countdown.textContent = countdownText;
  }
  const progress = Math.max(3, Math.min(100, 100 - (next.waitSeconds / 3600) * 100));
  els.countdownProgressFill.style.width = `${progress}%`;

  const staticKey = `${route.id}|${state.activeStopIndex}|${next.index}|${next.targetAt}|${next.wait}|${state.currentPosition ? "gps" : "nogps"}`;
  if (state.homeRenderKey === staticKey) return;
  state.homeRenderKey = staticKey;

  els.stopSwitcher.innerHTML = stops.map((stop) => `
    <button class="${stop.index === state.activeStopIndex ? "active" : ""}" type="button" data-stop-index="${stop.index}">
      ${escapeHTML(stop.shortName || stop.name)}
    </button>
  `).join("");

  const guidance = commuteGuidance(route, state.activeStopIndex, next);
  els.commuteAdvice.dataset.state = guidance.state;
  els.commuteAdvice.innerHTML = `<strong>${escapeHTML(guidance.state)}: ${escapeHTML(guidance.title)}</strong><span>${escapeHTML(guidance.detail)}</span>`;
  els.routeMap.innerHTML = renderRouteMap(route);
  els.arrivalList.innerHTML = route.stops
    .slice(state.activeStopIndex + 1)
    .map((stop) => {
      const arrival = next.row[stop.index];
      const rideMinutes = normalizeArrival(next.row, stop.index, next.minutes) - next.minutes;
      return `<div><span>${escapeHTML(stop.name)}</span><strong>${arrival}</strong><small>${rideMinutes} min ride</small></div>`;
    })
    .join("") || `<div><span>End of route</span><strong>${next.row[state.activeStopIndex]}</strong><small>No downstream stops</small></div>`;

  els.upcomingGrid.innerHTML = getTimedRows(route, state.activeStopIndex)
    .slice(0, 5)
    .map(({ row, wait }) => `
      <article>
        <span>${escapeHTML(activeStop?.shortName || activeStop?.name || "Stop")}</span>
        <strong>${row[state.activeStopIndex]}</strong>
        <small>${formatDuration(wait)}</small>
      </article>
    `)
    .join("");
}

function renderRouteMap(route) {
  if (!route) return "";
  const bucket = locationBucket(route.id);
  const stops = route.stops;
  const pulseLeft = route.stops.length > 1
    ? Math.min(100, Math.max(0, (state.activeStopIndex / (route.stops.length - 1)) * 100))
    : 0;
  return `
    <div class="route-line" style="--stops:${stops.length}">
      <b class="route-pulse" style="--pulse-left:${pulseLeft}%"></b>
      ${stops.map((stop) => {
        const hasLocation = Boolean(bucket[stop.id]);
        const active = stop.index === state.activeStopIndex;
        const passed = stop.index < state.activeStopIndex;
        return `
          <div class="route-stop ${active ? "active" : ""} ${passed ? "passed" : ""} ${hasLocation ? "located" : ""}">
            <i></i>
            <span>${escapeHTML(stop.shortName || stop.name)}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderRoutes() {
  if (!state.routes.length) {
    els.routeList.innerHTML = emptyState("No routes saved yet. Upload a PDF to create your first route.");
    return;
  }

  els.routeList.innerHTML = state.routes.map((route) => {
    const locations = savedLocationCount(route);
    const routeStopIndex = getLastStopIndex(route);
    const preview = getTimedRows(route, routeStopIndex).slice(0, 3);
    return `
    <article class="route-card">
      <div class="topline">
        <span>${route.rows.length} rows</span>
        <span>${locations.saved}/${locations.total} stops located</span>
      </div>
      <div>
        <h2>${escapeHTML(route.name)}</h2>
        <small>${escapeHTML(route.fileName || "Uploaded PDF")} · Updated ${formatDate(route.updatedAt)}</small>
      </div>
      <small>${escapeHTML(route.stops.map((stop) => stop.shortName || stop.name).join(" → "))}</small>
      <div class="health-list">
        <span>${route.fileName ? "PDF saved" : "PDF missing"}</span>
        <span>${route.effectiveDate || "No effective date"}</span>
        <span>${route.rows.length} departures</span>
      </div>
      <div class="route-preview">
        ${preview.map(({ row, wait }) => `<span>${row[routeStopIndex]} · ${formatDuration(wait)}</span>`).join("") || "<span>No upcoming departures</span>"}
      </div>
      <div class="actions">
        <button class="button primary" type="button" data-select-route="${route.id}">${route.id === state.activeRouteId ? "Current route" : "Use route"}</button>
        <button class="button secondary compact" type="button" data-delete-route="${route.id}">Delete</button>
      </div>
    </article>
  `; }).join("");
}

function renderUploadReview() {
  els.reviewCard.classList.toggle("hidden", !state.pendingUpload);
  els.existingRouteSelect.innerHTML = state.routes.map((route) => `
    <option value="${route.id}">${escapeHTML(route.name)}</option>
  `).join("");

  if (!state.pendingUpload) return;
  const pending = state.pendingUpload;
  els.reviewRouteName.value = pending.name;
  els.reviewEffectiveDate.value = pending.effectiveDate || "";
  els.reviewMeta.innerHTML = `
    <span>${pending.stops.length} stops</span>
    <span>${pending.rows.length} rows</span>
    <span>${escapeHTML(pending.fileName)}</span>
  `;
  els.stopEditor.innerHTML = pending.stops.map((stop, index) => `
    <label>
      Stop ${index + 1}
      <input type="text" value="${escapeHTML(stop.name)}" data-stop-name="${index}" autocomplete="off">
    </label>
  `).join("");
  els.sampleTable.innerHTML = makeMiniTable(pending.stops, pending.rows.slice(0, 3));

  const recommended = findBestRouteMatch(pending);
  els.saveMode.value = recommended ? "update" : "new";
  if (recommended) els.existingRouteSelect.value = recommended.id;
}

function renderSchedule() {
  const route = activeRoute();
  if (!route) {
    els.scheduleSummary.textContent = "Upload or choose a route to view the full table.";
    els.scheduleHead.innerHTML = "";
    els.scheduleBody.innerHTML = `<tr><td>No route selected.</td></tr>`;
    return;
  }

  els.scheduleSummary.textContent = `${route.name}: ${route.rows.length} rows, ${route.stops.length} stops.`;
  els.scheduleHead.innerHTML = `<tr>${route.stops.map((stop, index) => `
    <th>${index === 0 ? "Depart " : ""}${escapeHTML(stop.shortName || stop.name)}</th>
  `).join("")}</tr>`;
  els.scheduleBody.innerHTML = route.rows.map((row) => `
    <tr>${row.map((time) => `<td>${time}</td>`).join("")}</tr>
  `).join("");
}

function renderSettings() {
  const route = activeRoute();
  if (!route) {
    els.locationList.innerHTML = emptyState("Choose or upload a route before setting locations.");
    renderMap();
    return;
  }

  const stops = departureStops(route);
  renderCommutePrefs(route);
  if (state.editingRouteId !== route.id) {
    state.editingRouteId = route.id;
    state.editingStopIndex = getLastStopIndex(route);
  }
  if (!stops.some((stop) => stop.index === state.editingStopIndex)) {
    state.editingStopIndex = getLastStopIndex(route);
  }
  const bucket = locationBucket(route.id);
  els.locationList.innerHTML = stops.map((stop) => {
    const saved = bucket[stop.id];
    const suggestions = saved ? [] : findLocationSuggestions(route, stop);
    return `
      <article class="${stop.index === state.editingStopIndex ? "active" : ""}">
        <button type="button" data-edit-stop="${stop.index}">
          <strong>${escapeHTML(stop.name)}</strong>
          <span>${saved ? `${saved.lat.toFixed(6)}, ${saved.lng.toFixed(6)}` : "No saved location"}</span>
        </button>
        ${suggestions.map((suggestion) => `
          <button class="copy-suggestion" type="button" data-copy-location-route="${suggestion.routeId}" data-copy-location-stop="${suggestion.stopId}" data-copy-target-stop="${stop.index}">
            Copy from ${escapeHTML(suggestion.routeName)}
          </button>
        `).join("")}
      </article>
    `;
  }).join("");

  const selected = route.stops[state.editingStopIndex];
  const saved = selected ? bucket[selected.id] : null;
  const position = saved || state.pickerPosition || DEFAULT_MAP_CENTER;
  state.pickerPosition = { lat: Number(position.lat), lng: Number(position.lng) };
  els.latInput.value = state.pickerPosition.lat.toFixed(6);
  els.lngInput.value = state.pickerPosition.lng.toFixed(6);
  const counts = savedLocationCount(route);
  els.settingsStatus.textContent = selected
    ? `Editing ${selected.name}. ${counts.saved}/${counts.total} stops located for ${route.name}.`
    : "Choose a stop to edit its location.";
  renderMap();
}

function renderCommutePrefs(route) {
  const prefs = commutePrefs(route?.id);
  els.walkingSpeed.value = prefs.walkingSpeed;
  els.bufferMinutes.value = prefs.bufferMinutes;
  const selected = new Set(prefs.reminderMinutes || DEFAULT_COMMUTE_PREFS.reminderMinutes);
  [
    els.reminderThirty,
    els.reminderTwenty,
    els.reminderTen,
    els.reminderFive,
    els.reminderTwo
  ].forEach((input) => {
    input.checked = selected.has(Number(input.dataset.reminderMinute));
  });
  const permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  if (!state.settings.notificationPrefs) state.settings.notificationPrefs = {};
  state.settings.notificationPrefs.permission = permission;
  els.notificationStatus.textContent = permission === "granted"
    ? "Notifications are enabled for this browser."
    : permission === "denied"
      ? "Notifications are blocked. In-app alerts will still work while open."
      : "Install to Home Screen on iPhone, then enable notifications when supported.";
}

async function saveCommutePrefs() {
  const route = activeRoute();
  if (!route) return;
  const prefs = commutePrefs(route.id);
  prefs.walkingSpeed = Math.max(30, Math.min(140, Number(els.walkingSpeed.value) || DEFAULT_COMMUTE_PREFS.walkingSpeed));
  prefs.bufferMinutes = Math.max(0, Math.min(20, Number(els.bufferMinutes.value) || 0));
  prefs.reminderMinutes = [
    els.reminderThirty,
    els.reminderTwenty,
    els.reminderTen,
    els.reminderFive,
    els.reminderTwo
  ].filter((input) => input.checked).map((input) => Number(input.dataset.reminderMinute));
  await saveSettings();
  renderHome();
}

function findLocationSuggestions(currentRoute, targetStop) {
  const target = normalizeName(targetStop.name);
  if (!target) return [];

  return state.routes
    .filter((route) => route.id !== currentRoute.id)
    .flatMap((route) => {
      const bucket = locationBucket(route.id);
      return departureStops(route)
        .filter((stop) => bucket[stop.id] && stopNamesMatch(target, normalizeName(stop.name)))
        .map((stop) => ({
          routeId: route.id,
          routeName: route.name,
          stopId: stop.id,
          stopName: stop.name,
          location: bucket[stop.id]
        }));
    })
    .slice(0, 2);
}

function stopNamesMatch(a, b) {
  return a === b || a.includes(b) || b.includes(a);
}

function renderSearchResults(results) {
  if (!results?.length) {
    const query = escapeHTML(state.lastSearchQuery || "");
    els.searchResults.innerHTML = `
      <p>No in-app map result found. Try the external map search below, then copy/adjust the pin here if needed.</p>
      <button type="button" data-external-search="google"><strong>Search Google Maps</strong><span>${query}</span></button>
      <button type="button" data-external-search="apple"><strong>Search Apple Maps</strong><span>${query}</span></button>
    `;
    return;
  }

  els.searchResults.innerHTML = results.map((result, index) => `
    <button type="button" data-search-result="${index}">
      <strong>${escapeHTML(result.name)}</strong>
      <span>${escapeHTML(result.address)}</span>
      <small>${escapeHTML(result.source || "Map search")}${result.distanceLabel ? ` · ${escapeHTML(result.distanceLabel)}` : ""}</small>
    </button>
  `).join("");
}

function emptyState(message) {
  return `<article class="route-card"><p>${escapeHTML(message)}</p></article>`;
}

function makeMiniTable(stops, rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${stops.map((stop) => `<th>${escapeHTML(stop.shortName || stop.name)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${row.map((time) => `<td>${time}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>
  `;
}

async function extractPdfLines(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data, disableWorker: true }).promise;
  const lines = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const groups = [];

    for (const item of content.items) {
      const text = item.str.trim();
      if (!text) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      let group = groups.find((candidate) => Math.abs(candidate.y - y) < 3);
      if (!group) {
        group = { y, items: [] };
        groups.push(group);
      }
      group.items.push({ x, text });
    }

    groups
      .sort((a, b) => b.y - a.y)
      .forEach((group) => {
        const line = group.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
        if (line) lines.push(line);
      });
  }

  return { pages: pdf.numPages, lines };
}

async function parsePdf(file) {
  const { pages, lines } = await extractPdfLines(file);
  const timeCounts = lines.map((line) => (line.match(TIME_RE) || []).length);
  const firstTimeLine = timeCounts.findIndex((count) => count >= 3);
  if (firstTimeLine < 1) throw new Error("Could not find a timetable header and time rows.");

  const counts = timeCounts.slice(firstTimeLine).filter((count) => count >= 3);
  const stopCount = mode(counts);
  if (!stopCount || stopCount < 3) throw new Error("Could not detect the number of stop columns.");

  const headerLine = lastItem(lines.slice(0, firstTimeLine).filter(Boolean));
  const footerLines = lines.slice(firstTimeLine).filter((line) => (line.match(TIME_RE) || []).length === 0);
  const routeName = detectRouteName(footerLines, file.name);
  const effectiveDate = detectEffectiveDate(footerLines);
  const stops = parseStops(headerLine, stopCount);
  const rows = [];

  for (let index = firstTimeLine; index < lines.length; index += 1) {
    const times = lines[index].match(TIME_RE) || [];
    if (times.length === stopCount) rows.push(times);
  }

  if (!rows.length) throw new Error("No complete timetable rows were found.");

  return {
    id: createId(routeName),
    name: routeName,
    effectiveDate,
    fileName: file.name,
    uploadedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
    stops,
    rows,
    source: { pages, headerLine, stopCount }
  };
}

function mode(values) {
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
}

function detectRouteName(lines, fileName) {
  const joined = lines.join(" ");
  const routeMatch = joined.match(/route\s*-?\s*(\d+)/i);
  if (routeMatch) return `Route ${routeMatch[1].padStart(2, "0")}`;
  const fromFile = fileName.match(/(?:^|[-_\s])r(?:oute)?\s*-?\s*(\d+)/i);
  if (fromFile) return `Route ${fromFile[1].padStart(2, "0")}`;
  return fileName.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim() || "Imported route";
}

function detectEffectiveDate(lines) {
  const joined = lines.join(" ");
  return joined.match(/effective\s+([^\]]+)/i)?.[1]?.trim() || "";
}

function parseStops(headerLine, stopCount) {
  const header = (headerLine || "").replace(/\s+/g, " ").trim();
  if (!header) {
    return Array.from({ length: stopCount }, (_, index) => makeStop(`Stop ${index + 1}`, index));
  }

  const bracketStops = parseBracketStops(header, stopCount);
  if (bracketStops) return bracketStops;

  const knownStops = [...header.matchAll(/DR\.?\s+KHALIFA|TECOM\s+\d+|PARK\s+ZABEEL\s+VIEW\s+\d+|EGHQ/gi)].map((match) => match[0]);
  if (knownStops.length === stopCount) {
    return knownStops.map((name, index) => makeStop(formatStopName(name), index));
  }

  const tokens = header.split(/\s+/);
  if (tokens.length === stopCount) {
    return tokens.map((name, index) => makeStop(formatStopName(name), index));
  }

  const first = tokens.shift() || "Stop 1";
  const last = lastItem(tokens);
  const middleText = last && normalizeName(last) === normalizeName(first) ? tokens.slice(0, -1).join(" ") : tokens.join(" ");
  const middleCount = last && normalizeName(last) === normalizeName(first) ? stopCount - 2 : stopCount - 1;
  const middle = splitEvenly(middleText.split(/\s+/).filter(Boolean), middleCount);
  const names = [first, ...middle, ...(middle.length === middleCount && last && normalizeName(last) === normalizeName(first) ? [last] : [])];

  while (names.length < stopCount) names.push(`Stop ${names.length + 1}`);
  return names.slice(0, stopCount).map((name, index) => makeStop(formatStopName(name), index));
}

function parseBracketStops(header, stopCount) {
  const matches = [...header.matchAll(/\[([^\]]+)\]/g)];
  if (!matches.length || matches.length + 2 !== stopCount) return null;

  const stops = [];
  let cursor = 0;
  matches.forEach((match, matchIndex) => {
    const segment = header.slice(cursor, match.index).trim();
    if (matchIndex === 0) {
      const [first, ...rest] = segment.split(/\s+/);
      stops.push(makeStop(first, stops.length));
      stops.push(makeStop(rest.join(" "), stops.length, match[1]));
    } else {
      stops.push(makeStop(segment, stops.length, match[1]));
    }
    cursor = match.index + match[0].length;
  });
  const tail = header.slice(cursor).trim();
  if (tail) stops.push(makeStop(tail, stops.length));
  return stops.length === stopCount ? stops : null;
}

function splitEvenly(tokens, groups) {
  if (groups <= 0) return [];
  const result = [];
  for (let index = 0; index < groups; index += 1) {
    const start = Math.round((index * tokens.length) / groups);
    const end = Math.round(((index + 1) * tokens.length) / groups);
    result.push(tokens.slice(start, end).join(" "));
  }
  return result.filter(Boolean);
}

function formatStopName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().replace(/\b\w/g, (char) => char.toUpperCase()).replace(/\bEghq\b/g, "EGHQ").replace(/\bTecom\b/g, "TECOM").replace(/\bDr\.\b/g, "DR.");
}

async function handlePdfUpload(event) {
  const [file] = event.target.files;
  if (!file) return;
  els.uploadStatus.textContent = "Reading PDF timetable...";
  try {
    state.pendingUpload = await parsePdf(file);
    location.hash = "#/upload";
    els.uploadStatus.textContent = "PDF parsed. Review the detected route below.";
    renderAll();
  } catch (error) {
    els.uploadStatus.textContent = `Could not read that PDF: ${error.message}`;
  } finally {
    event.target.value = "";
  }
}

function findBestRouteMatch(candidate) {
  const candidateStops = candidate.stops.map((stop) => normalizeName(stop.name)).join("|");
  return state.routes.find((route) => normalizeName(route.name) === normalizeName(candidate.name)) ||
    state.routes.find((route) => route.stops.map((stop) => normalizeName(stop.name)).join("|") === candidateStops);
}

async function savePendingUpload() {
  if (!state.pendingUpload) return;
  const candidate = cloneJson(state.pendingUpload);
  candidate.name = els.reviewRouteName.value.trim() || candidate.name;
  candidate.effectiveDate = els.reviewEffectiveDate.value.trim();
  candidate.stops = [...document.querySelectorAll("[data-stop-name]")].map((input, index) =>
    makeStop(input.value.trim() || `Stop ${index + 1}`, index, candidate.stops[index]?.shortName || "")
  );

  const modeValue = els.saveMode.value;
  let locationsChanged = false;
  if (modeValue === "update" && els.existingRouteSelect.value) {
    const existing = state.routes.find((route) => route.id === els.existingRouteSelect.value);
    if (existing) {
      candidate.id = existing.id;
      candidate.uploadedAt = existing.uploadedAt;
      preserveLocations(existing, candidate);
      locationsChanged = true;
    }
  }

  candidate.updatedAt = new Date().toISOString();
  await idbPut(ROUTE_STORE, candidate);
  if (locationsChanged) await saveSettings();
  state.routes = (await idbGetAll(ROUTE_STORE)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  setActiveRoute(candidate.id);
  state.pendingUpload = null;
  els.uploadStatus.textContent = `${candidate.name} saved.`;
  location.hash = "#/home";
  renderAll();
}

function preserveLocations(existing, candidate) {
  const bucket = locationBucket(existing.id);
  const nextBucket = {};
  candidate.stops.forEach((newStop) => {
    const oldStop = existing.stops.find((stop) => normalizeName(stop.name) === normalizeName(newStop.name)) ||
      existing.stops.find((stop) => stop.index === newStop.index);
    if (oldStop && bucket[oldStop.id]) nextBucket[newStop.id] = bucket[oldStop.id];
  });
  state.settings.stopLocationsByRoute[candidate.id] = nextBucket;
}

function setActiveRoute(routeId) {
  if (!routeId) {
    state.activeRouteId = null;
    state.activeStopIndex = 0;
    state.editingRouteId = null;
    localStorage.removeItem(LAST_ROUTE_KEY);
    return;
  }
  state.activeRouteId = routeId;
  state.activeStopIndex = getLastStopIndex(activeRoute());
  state.editingRouteId = routeId;
  state.editingStopIndex = state.activeStopIndex;
  localStorage.setItem(LAST_ROUTE_KEY, routeId);
}

async function deleteRoute(routeId) {
  const route = state.routes.find((item) => item.id === routeId);
  if (!route || !window.confirm(`Delete ${route.name}? This removes its saved timetable and stop locations from this browser.`)) return;
  await idbDelete(ROUTE_STORE, routeId);
  delete state.settings.stopLocationsByRoute[routeId];
  await saveSettings();
  state.routes = state.routes.filter((item) => item.id !== routeId);
  if (state.activeRouteId === routeId) setActiveRoute(state.routes[0]?.id || null);
  renderAll();
}

function distanceInMeters(a, b) {
  const radius = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function requestLocation(success, failure) {
  if (!navigator.geolocation) {
    failure?.("Location is unavailable in this browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    success,
    () => failure?.("Location permission was denied or timed out."),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

function useNearestStop() {
  const route = activeRoute();
  if (!route) return;
  els.distanceReadout.textContent = "Locating...";
  requestLocation((position) => {
    state.currentPosition = { lat: position.coords.latitude, lng: position.coords.longitude };
    const bucket = locationBucket(route.id);
    const candidates = departureStops(route)
      .map((stop) => bucket[stop.id] ? { stop, distance: distanceInMeters(state.currentPosition, bucket[stop.id]) } : null)
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance);

    if (!candidates.length) {
      els.distanceReadout.textContent = "No saved stop locations; using first stop.";
      state.activeStopIndex = departureStops(route)[0]?.index || 0;
    } else {
      state.activeStopIndex = candidates[0].stop.index;
      els.distanceReadout.textContent = `${Math.round(candidates[0].distance)} m away`;
    }
    rememberStop(route.id, state.activeStopIndex);
    renderAll();
  }, (message) => {
    els.distanceReadout.textContent = `${message} Using first stop.`;
    state.activeStopIndex = departureStops(route)[0]?.index || 0;
    rememberStop(route.id, state.activeStopIndex);
    renderAll();
  });
}

function selectLocationStop(stopIndex) {
  const route = activeRoute();
  if (!route) return;
  state.editingStopIndex = stopIndex;
  state.editingRouteId = route.id;
  const stop = route.stops[stopIndex];
  const saved = locationBucket(route.id)[stop.id];
  state.pickerPosition = saved || state.currentPosition || state.pickerPosition || DEFAULT_MAP_CENTER;
  renderSettings();
}

function updatePickerFromInputs() {
  const lat = Number(els.latInput.value);
  const lng = Number(els.lngInput.value);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    state.pickerPosition = { lat, lng };
    renderMap();
  }
}

async function saveStopLocation() {
  const route = activeRoute();
  const stop = route?.stops[state.editingStopIndex];
  if (!route || !stop) return;
  updatePickerFromInputs();
  locationBucket(route.id)[stop.id] = {
    lat: state.pickerPosition.lat,
    lng: state.pickerPosition.lng,
    savedAt: new Date().toISOString()
  };
  state.activeStopIndex = stop.index;
  state.settings.lastStopByRoute[route.id] = stop.index;
  await saveSettings();
  els.settingsStatus.textContent = `${stop.name} location saved.`;
  renderAll();
}

async function clearStopLocation() {
  const route = activeRoute();
  const stop = route?.stops[state.editingStopIndex];
  if (!route || !stop) return;
  delete locationBucket(route.id)[stop.id];
  await saveSettings();
  els.settingsStatus.textContent = `${stop.name} location cleared.`;
  renderAll();
}

async function copyLocationFromRoute(sourceRouteId, sourceStopId, targetStopIndex) {
  const route = activeRoute();
  const targetStop = route?.stops[targetStopIndex];
  const source = state.settings.stopLocationsByRoute?.[sourceRouteId]?.[sourceStopId];
  if (!route || !targetStop || !source) return;

  locationBucket(route.id)[targetStop.id] = {
    lat: source.lat,
    lng: source.lng,
    savedAt: new Date().toISOString(),
    copiedFromRouteId: sourceRouteId,
    copiedFromStopId: sourceStopId
  };
  state.editingStopIndex = targetStop.index;
  state.activeStopIndex = targetStop.index;
  state.settings.lastStopByRoute[route.id] = targetStop.index;
  await saveSettings();
  state.pickerPosition = { lat: source.lat, lng: source.lng };
  els.settingsStatus.textContent = `${targetStop.name} location copied.`;
  renderAll();
}

function renderMap() {
  const { lat, lng } = state.pickerPosition;
  const zoom = 15;
  const centerTile = latLngToTile(lat, lng, zoom);
  const centerPixel = latLngToWorldPixel(lat, lng, zoom);
  const tileOffsetX = centerPixel.x % 256;
  const tileOffsetY = centerPixel.y % 256;
  const tiles = [];
  for (let y = centerTile.y - 1; y <= centerTile.y + 1; y += 1) {
    for (let x = centerTile.x - 1; x <= centerTile.x + 1; x += 1) {
      tiles.push(`<img alt="" src="https://tile.openstreetmap.org/${zoom}/${x}/${y}.png">`);
    }
  }
  els.tileGrid.innerHTML = tiles.join("");
  els.tileGrid.style.transform = `translate(${-256 - tileOffsetX}px, ${-256 - tileOffsetY}px)`;
  els.openMapLink.dataset.appleMapsUrl = `https://maps.apple.com/?ll=${lat},${lng}&q=Bus%20stop`;
  els.openMapLink.dataset.osmUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`;
}

async function searchLocations(event) {
  event.preventDefault();
  const query = els.locationSearch.value.trim();
  if (!query) return;

  state.lastSearchQuery = query;
  els.settingsStatus.textContent = "Searching places...";
  els.searchResults.innerHTML = `<p>Searching...</p>`;

  try {
    const results = await findPlaces(query);

    state.searchResults = results;
    renderSearchResults(results);
    els.settingsStatus.textContent = results.length ? "Choose a result to move the pin." : "No matching places found.";
  } catch (error) {
    state.searchResults = [];
    els.searchResults.innerHTML = `<p>Search needs internet. Use GPS, tap the map, or enter coordinates manually.</p>`;
    els.settingsStatus.textContent = error.message || "Place search failed.";
  }
}

async function findPlaces(query) {
  const aliasResults = findAliasPlaces(query);
  const variants = buildSearchQueries(query);
  const providerResults = [];

  for (const variant of variants) {
    const [nominatim, photon] = await Promise.allSettled([
      searchNominatim(variant),
      searchPhoton(variant)
    ]);
    if (nominatim.status === "fulfilled") providerResults.push(...nominatim.value);
    if (photon.status === "fulfilled") providerResults.push(...photon.value);
    if (providerResults.length >= 6) break;
  }

  return rankPlaces(dedupePlaces([...aliasResults, ...providerResults]), query).slice(0, 8);
}

function findAliasPlaces(query) {
  const normalized = normalizeName(query);
  return PLACE_ALIASES
    .filter((place) => place.terms.some((term) => normalized.includes(normalizeName(term)) || normalizeName(term).includes(normalized)))
    .map((place) => ({ ...place, source: "Saved match" }));
}

function buildSearchQueries(query) {
  const cleaned = query.replace(/\s+/g, " ").trim();
  const variants = new Set([
    cleaned,
    `${cleaned} Dubai`,
    `${cleaned} UAE`,
    `${cleaned} Al Karama Dubai`
  ]);

  if (/al\s+fattan\s+park\s+tower/i.test(cleaned) && !/view/i.test(cleaned)) {
    variants.add(cleaned.replace(/park\s+tower/i, "Park View Tower"));
    variants.add("Al Fattan Park View Tower Dubai");
    variants.add("119 Sheikh Rashid Road Al Karama Dubai");
  }

  if (/al\s+shafar\s+park\s+tower/i.test(cleaned)) {
    variants.add("Al Shafar Park Tower Al Karama Dubai");
    variants.add("Al Shafar Park Tower Sheikh Rashid Road Dubai");
    variants.add("MedX Pharmacy Karama Al Shafar Park Tower");
  }

  return [...variants];
}

async function searchNominatim(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "6");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "ae");
  url.searchParams.set("viewbox", "55.05,25.38,55.48,24.98");
  url.searchParams.set("bounded", "0");
  url.searchParams.set("q", query);

  const response = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  if (!response.ok) return [];
  const data = await response.json();
  return data.map((item) => ({
    name: item.name || item.display_name.split(",")[0],
    address: item.display_name,
    lat: Number(item.lat),
    lng: Number(item.lon),
    source: "OpenStreetMap"
  })).filter(isValidPlace);
}

async function searchPhoton(query) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "6");
  url.searchParams.set("lat", "25.2356");
  url.searchParams.set("lon", "55.2979");

  const response = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.features || []).map((feature) => {
    const props = feature.properties || {};
    const [lng, lat] = feature.geometry?.coordinates || [];
    const parts = [props.name, props.street, props.district, props.city, props.country].filter(Boolean);
    return {
      name: props.name || query,
      address: parts.join(", "),
      lat: Number(lat),
      lng: Number(lng),
      source: "Photon"
    };
  }).filter((place) => isValidPlace(place) && place.address.toLowerCase().includes("dubai"));
}

function isValidPlace(place) {
  return place?.name && Number.isFinite(place.lat) && Number.isFinite(place.lng);
}

function dedupePlaces(places) {
  const seen = new Set();
  return places.filter((place) => {
    const key = `${normalizeName(place.name)}-${place.lat.toFixed(4)}-${place.lng.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankPlaces(places, query) {
  const normalizedQuery = normalizeName(query);
  const reference = state.currentPosition || state.pickerPosition || DEFAULT_MAP_CENTER;

  return places
    .map((place) => {
      const normalizedName = normalizeName(place.name);
      const normalizedAddress = normalizeName(place.address);
      const distance = distanceInMeters(reference, place);
      const exact = normalizedName === normalizedQuery ? 0 : normalizedName.includes(normalizedQuery) ? 1 : 2;
      const parkPenalty = normalizedQuery.includes("park") && !normalizedName.includes("park") && !normalizedAddress.includes("park") ? 3 : 0;
      const sourceBoost = place.source === "Saved match" ? -2 : 0;
      return {
        ...place,
        distance,
        distanceLabel: distance < 1000 ? `${Math.round(distance)} m from map` : `${(distance / 1000).toFixed(1)} km from map`,
        score: exact + parkPenalty + sourceBoost + distance / 100000
      };
    })
    .sort((a, b) => a.score - b.score);
}

function chooseSearchResult(index) {
  const result = state.searchResults?.[index];
  if (!result) return;

  state.pickerPosition = { lat: result.lat, lng: result.lng };
  els.latInput.value = result.lat.toFixed(6);
  els.lngInput.value = result.lng.toFixed(6);
  els.settingsStatus.textContent = `${result.name} selected. Tap Save stop location to remember it.`;
  renderMap();
}

function openExternalSearch(kind) {
  const query = encodeURIComponent(state.lastSearchQuery || els.locationSearch.value.trim() || "Dubai");
  const url = kind === "apple"
    ? `https://maps.apple.com/?q=${query}`
    : `https://www.google.com/maps/search/?api=1&query=${query}`;
  const popup = window.open(url, "_blank", "noopener,noreferrer");
  if (!popup) window.location.href = url;
}

function latLngToTile(lat, lng, zoom) {
  const scale = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * scale);
  const y = Math.floor((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2 * scale);
  return { x, y };
}

function latLngToWorldPixel(lat, lng, zoom) {
  const scale = 256 * 2 ** zoom;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale
  };
}

function worldPixelToLatLng(x, y, zoom) {
  const scale = 256 * 2 ** zoom;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

function pickMapPoint(event) {
  if (!activeRoute()) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const center = latLngToWorldPixel(state.pickerPosition.lat, state.pickerPosition.lng, 15);
  const picked = worldPixelToLatLng(
    center.x + event.clientX - (rect.left + rect.width / 2),
    center.y + event.clientY - (rect.top + rect.height / 2),
    15
  );
  state.pickerPosition = picked;
  els.latInput.value = picked.lat.toFixed(6);
  els.lngInput.value = picked.lng.toFixed(6);
  els.settingsStatus.textContent = "Pin moved. Tap Save stop location to remember it.";
  renderMap();
}

function openExternalMap() {
  const url = els.openMapLink.dataset.appleMapsUrl || els.openMapLink.dataset.osmUrl;
  if (!url) return;

  els.settingsStatus.textContent = "Opening the selected pin in Maps...";
  const popup = window.open(url, "_blank", "noopener,noreferrer");
  if (!popup) {
    window.location.href = url;
  }
}

async function enableNotifications() {
  if (typeof Notification === "undefined") {
    els.notificationStatus.textContent = "This browser does not support notifications here. In-app alerts still work.";
    return;
  }
  const permission = await Notification.requestPermission();
  if (!state.settings.notificationPrefs) state.settings.notificationPrefs = {};
  state.settings.notificationPrefs.enabled = permission === "granted";
  state.settings.notificationPrefs.permission = permission;
  await saveSettings();
  els.notificationStatus.textContent = permission === "granted"
    ? "Notifications enabled. Keep the app installed/open for best reliability."
    : "Notifications not enabled. In-app alerts still work while open.";
}

function maybeInAppAlert() {
  const route = activeRoute();
  const next = route ? getTimedRows(route, state.activeStopIndex)[0] : null;
  if (!route || !next) return;

  activeReminderMinutes(route.id).forEach((minute) => {
    const targetSeconds = minute * 60;
    if (next.waitSeconds > targetSeconds || next.waitSeconds < targetSeconds - 5) return;
    const reminderKey = `${route.id}-${state.activeStopIndex}-${next.index}-${next.targetAt}-${minute}`;
    if (state.lastReminderKey === reminderKey) return;
    state.lastReminderKey = reminderKey;
    if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
    const body = `${route.name} from ${route.stops[state.activeStopIndex]?.shortName || route.stops[state.activeStopIndex]?.name || "your stop"} departs at ${next.row[state.activeStopIndex]}.`;
    if (state.settings.notificationPrefs?.enabled && typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(`${minute} min until your bus`, { body });
    } else {
      showInAppAlert(`${minute} min until your bus`, body);
    }
  });

  const guidance = commuteGuidance(route, state.activeStopIndex, next);
  if (!["Leave now", "You may miss this"].includes(guidance.state)) return;
  if (state.lastAlertKey === `${route.id}-${next.index}-${guidance.state}`) return;
  state.lastAlertKey = `${route.id}-${next.index}-${guidance.state}`;
  if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
  if (state.settings.notificationPrefs?.enabled && typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification("Bus Times", { body: `${guidance.state}: ${guidance.title}` });
  } else {
    showInAppAlert(guidance.state, guidance.title);
  }
}

function showInAppAlert(title, body) {
  const existing = document.querySelector(".toast-alert");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = "toast-alert";
  toast.innerHTML = `<strong>${escapeHTML(title)}</strong><span>${escapeHTML(body)}</span>`;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 8000);
}

function nudgePicker(direction) {
  const amount = 0.00012;
  const delta = {
    north: { lat: amount, lng: 0 },
    south: { lat: -amount, lng: 0 },
    east: { lat: 0, lng: amount },
    west: { lat: 0, lng: -amount }
  }[direction];
  if (!delta) return;
  state.pickerPosition = {
    lat: state.pickerPosition.lat + delta.lat,
    lng: state.pickerPosition.lng + delta.lng
  };
  els.latInput.value = state.pickerPosition.lat.toFixed(6);
  els.lngInput.value = state.pickerPosition.lng.toFixed(6);
  renderMap();
}

function handleRoute() {
  const view = (location.hash.match(/^#\/([a-z]+)/)?.[1] || "home").toLowerCase();
  state.activeView = ["home", "routes", "upload", "schedule", "settings"].includes(view) ? view : "home";
  renderAll();
}

function wireEvents() {
  window.addEventListener("hashchange", handleRoute);
  els.pdfInput.addEventListener("change", handlePdfUpload);
  els.locateButton.addEventListener("click", useNearestStop);
  els.stopSwitcher.addEventListener("click", (event) => {
    const button = event.target.closest("[data-stop-index]");
    if (!button) return;
    state.activeStopIndex = Number(button.dataset.stopIndex);
    els.distanceReadout.textContent = "Selected manually";
    rememberStop(state.activeRouteId, state.activeStopIndex);
    renderAll();
  });
  els.routeList.addEventListener("click", async (event) => {
    const select = event.target.closest("[data-select-route]");
    const remove = event.target.closest("[data-delete-route]");
    if (select) {
      setActiveRoute(select.dataset.selectRoute);
      location.hash = "#/home";
      renderAll();
    }
    if (remove) await deleteRoute(remove.dataset.deleteRoute);
  });
  els.saveUpload.addEventListener("click", savePendingUpload);
  els.cancelUpload.addEventListener("click", () => {
    state.pendingUpload = null;
    els.uploadStatus.textContent = "Upload cancelled.";
    renderAll();
  });
  els.locationList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit-stop]");
    const copy = event.target.closest("[data-copy-location-route]");
    if (button) selectLocationStop(Number(button.dataset.editStop));
    if (copy) {
      copyLocationFromRoute(
        copy.dataset.copyLocationRoute,
        copy.dataset.copyLocationStop,
        Number(copy.dataset.copyTargetStop)
      );
    }
  });
  els.useCurrentLocation.addEventListener("click", () => {
    els.settingsStatus.textContent = "Locating...";
    requestLocation((position) => {
      state.currentPosition = { lat: position.coords.latitude, lng: position.coords.longitude };
      state.pickerPosition = { ...state.currentPosition };
      els.latInput.value = state.pickerPosition.lat.toFixed(6);
      els.lngInput.value = state.pickerPosition.lng.toFixed(6);
      els.settingsStatus.textContent = "GPS location loaded. Save it if this is the stop position.";
      renderMap();
    }, (message) => {
      els.settingsStatus.textContent = message;
    });
  });
  els.locationSearchForm.addEventListener("submit", searchLocations);
  els.searchResults.addEventListener("click", (event) => {
    const button = event.target.closest("[data-search-result]");
    if (button) chooseSearchResult(Number(button.dataset.searchResult));
    const external = event.target.closest("[data-external-search]");
    if (external) openExternalSearch(external.dataset.externalSearch);
  });
  document.querySelector(".nudge-grid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-nudge]");
    if (button) nudgePicker(button.dataset.nudge);
  });
  document.querySelector("#map-picker").addEventListener("click", pickMapPoint);
  els.openMapLink.addEventListener("click", openExternalMap);
  els.latInput.addEventListener("change", updatePickerFromInputs);
  els.lngInput.addEventListener("change", updatePickerFromInputs);
  els.saveLocation.addEventListener("click", saveStopLocation);
  els.clearLocation.addEventListener("click", clearStopLocation);
  [
    els.walkingSpeed,
    els.bufferMinutes,
    els.reminderThirty,
    els.reminderTwenty,
    els.reminderTen,
    els.reminderFive,
    els.reminderTwo
  ].forEach((input) => {
    input.addEventListener("change", saveCommutePrefs);
  });
  els.enableNotifications.addEventListener("click", enableNotifications);
  window.setInterval(() => {
    renderHome();
    maybeInAppAlert();
  }, 1000);
}

function initStarfield() {
  const canvas = document.querySelector("#starfield");
  const ctx = canvas.getContext("2d");
  let width = 0;
  let height = 0;
  let particles = [];
  let pointer = { x: 0, y: 0, active: false };

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.min(70, Math.floor((width * height) / 18000));
    particles = Array.from({ length: count }, () => createParticle(true));
  }

  function createParticle(randomizeY = false) {
    const hue = Math.random() > 0.5 ? "55, 213, 255" : "119, 224, 162";
    return {
      x: Math.random() * width,
      y: randomizeY ? Math.random() * height : height + 20,
      vx: (Math.random() - 0.5) * 0.16,
      vy: -0.1 - Math.random() * 0.28,
      size: 0.7 + Math.random() * 1.6,
      alpha: 0.16 + Math.random() * 0.38,
      hue
    };
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    for (const particle of particles) {
      if (pointer.active) {
        const dx = particle.x - pointer.x;
        const dy = particle.y - pointer.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 120) {
          const force = (120 - distance) / 120;
          particle.x += (dx / distance) * force || 0;
          particle.y += (dy / distance) * force || 0;
        }
      }
      particle.x += particle.vx;
      particle.y += particle.vy;
      if (particle.y < -30 || particle.x < -40 || particle.x > width + 40) {
        Object.assign(particle, createParticle());
      }
      ctx.beginPath();
      ctx.fillStyle = `rgba(${particle.hue}, ${particle.alpha})`;
      ctx.shadowBlur = 12;
      ctx.shadowColor = `rgba(${particle.hue}, 0.55)`;
      ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", (event) => {
    pointer = { x: event.clientX, y: event.clientY, active: true };
  });
  window.addEventListener("pointerleave", () => {
    pointer.active = false;
  });
  resize();
  draw();
}

async function init() {
  wireEvents();
  initStarfield();
  await loadState();
  registerServiceWorker();
  if (!location.hash || location.hash === "#setup") location.hash = "#/home";
  handleRoute();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

init().catch((error) => {
  els.headerRoute.textContent = "Storage error";
  els.countdown.textContent = error.message;
});
