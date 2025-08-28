// === 0. Global layer and data storage ===
let busLayer = null;
let busRouteFeatures = [];
let facilityLayer = null;
let importantFacilityLayer = null;
console.log(typeof proj4); // Should log 'function' if proj4 is loaded correctly

proj4.defs("EPSG:6671", "+proj=tmerc +lat_0=36 +lon_0=132.1666666666667 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs");

// === Folder Upload Handling ===
document.getElementById("folderUpload").addEventListener("change", async (event) => {
  const files = Array.from(event.target.files);
  const spinner = document.getElementById("folderUploadSpinner");
  const labelText = document.getElementById("folderUploadLabel");

  spinner.style.display = "inline";
  if (labelText) labelText.textContent = "読み込み中...";

  await new Promise(r => setTimeout(r, 100));

  const fileMap = {};
  for (let file of files) {
    fileMap[file.name] = file;
  }

  const scenarioData = {};

  if (fileMap["output_trips.csv.gz"]) {
    const csv = await decompressGZ(fileMap["output_trips.csv.gz"]);
    scenarioData.trips = parseTripsCSV(csv);
  }

  if (fileMap["output_plans.xml.gz"]) {
    const plansFile = fileMap["output_plans.xml.gz"];
    const sizeMB = plansFile.size / (1024 * 1024);
    if (sizeMB > 30) {
      console.warn(`Skipping output_plans.xml.gz (size: ${sizeMB.toFixed(1)} MB) to avoid browser freeze`);
    } else {
      const xml = await decompressGZToXML(plansFile);
      scenarioData.plans = parsePlansXML(xml, 100);
    }
  }

  if (fileMap["output_network.xml.gz"]) {
    const xml = await decompressGZToXML(fileMap["output_network.xml.gz"]);
    scenarioData.network = parseNetworkXML(xml);
    busRouteFeatures = scenarioData.network;
    displayBusLinks(scenarioData.network);
  }

  if (fileMap["output_facilities.xml.gz"]) {
    const xml = await decompressGZToXML(fileMap["output_facilities.xml.gz"]);
    scenarioData.facilities = parseFacilitiesXML(xml);
    displayFacilityHeatmap(scenarioData.facilities); // default heatmap
    displayImportantFacilities(scenarioData.facilities); // default top 20
  }

  spinner.style.display = "none";
  if (labelText) labelText.textContent = "🚌 ネットワーク読込";

  console.log("Parsed MATSim scenario:", scenarioData);
});

// === GZ Decompression Helpers ===
function decompressGZ(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const compressed = new Uint8Array(e.target.result);
        const decompressed = pako.ungzip(compressed, { to: "string" });
        resolve(decompressed);
      } catch (err) {
        reject("Failed to decompress: " + err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function decompressGZToXML(file) {
  return decompressGZ(file).then(xmlStr =>
    new DOMParser().parseFromString(xmlStr, "text/xml")
  );
}

// === Coordinate Projection ===
function atlantisToWGS84(x, y) {
  try {
    const [lon, lat] = proj4("EPSG:6671", "EPSG:4326", [x, y]);
    return [lon, lat];
  } catch (e) {
    console.error("Projection failed:", e, x, y);
    return [0, 0];
  }
}

// === Parse Network XML (Bus Links Only) ===
function parseNetworkXML(xml) {
  const nodeElems = xml.getElementsByTagName("node");
  const linkElems = xml.getElementsByTagName("link");

  const nodes = {};
  for (let node of nodeElems) {
    const id = node.getAttribute("id");
    const x = parseFloat(node.getAttribute("x"));
    const y = parseFloat(node.getAttribute("y"));
    if (!isNaN(x) && !isNaN(y)) {
      nodes[id] = atlantisToWGS84(x, y);
    }
  }

  const features = [];
  for (let link of linkElems) {
    const from = link.getAttribute("from");
    const to = link.getAttribute("to");
    const modes = link.getAttribute("modes") || "";
    if (nodes[from] && nodes[to] && /\bbus\b/.test(modes)) {
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [nodes[from], nodes[to]]
        },
        properties: { id: link.getAttribute("id"), modes }
      });
    }
  }

  return features;
}

// === Parse Facilities XML ===
function parseFacilitiesXML(xml) {
  const facilities = [];
  const facilityElems = xml.getElementsByTagName("facility");

  for (let facility of facilityElems) {
    const id = facility.getAttribute("id");
    const x = parseFloat(facility.getAttribute("x"));
    const y = parseFloat(facility.getAttribute("y"));
    const [lon, lat] = atlantisToWGS84(x, y);

    const attrMap = {};
    const attributes = facility.getElementsByTagName("attribute");
    for (let attr of attributes) {
      const name = attr.getAttribute("name");
      const value = attr.textContent;
      attrMap[name] = value;
    }

    facilities.push({
      id,
      x, y, lon, lat,
      bld_type: attrMap["bld_type"],
      business_area: parseFloat(attrMap["business_area"] || 0),
      residential_area: parseFloat(attrMap["residential_area"] || 0),
    });
  }

  return facilities;
}

// === Display Facilities Heatmap ===
function displayFacilityHeatmap(facilities, typeFilter = null) {
  if (facilityLayer) map.removeLayer(facilityLayer);

  const gridSizeDeg = 0.001;
  const grid = {};

  for (let f of facilities) {
    if (typeFilter && f.bld_type !== typeFilter) continue;
    const gx = Math.floor(f.lon / gridSizeDeg);
    const gy = Math.floor(f.lat / gridSizeDeg);
    const key = `${gx},${gy}`;
    grid[key] = (grid[key] || 0) + 1;
  }

  const rectangles = [];

  for (let [key, count] of Object.entries(grid)) {
    const [gx, gy] = key.split(",").map(Number);
    const bounds = [
      [gy * gridSizeDeg, gx * gridSizeDeg],
      [(gy + 1) * gridSizeDeg, (gx + 1) * gridSizeDeg]
    ];
    const color = `rgba(255, 0, 0, ${Math.min(0.7, count / 10)})`;

    rectangles.push(L.rectangle(bounds, {
      weight: 0.5,
      color: "#800000",
      fillColor: color,
      fillOpacity: 0.5
    }));
  }

  facilityLayer = L.layerGroup(rectangles);
  const toggle = document.getElementById("toggleFacilityHeatmap");
  if (!toggle || toggle.checked) {
    facilityLayer.addTo(map);
  }
}

// === Display Important Facilities ===
function displayImportantFacilities(facilities, topN = 20) {
  if (importantFacilityLayer) map.removeLayer(importantFacilityLayer);

  const sorted = facilities
    .slice()
    .sort((a, b) => (b.business_area + b.residential_area) - (a.business_area + a.residential_area))
    .slice(0, topN);

  const icon = L.icon({
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34]
  });

  const markers = sorted.map(f =>
    L.marker([f.lat, f.lon], { icon }).bindPopup(`
      <strong>施設 ID:</strong> ${f.id}<br>
      <strong>タイプ:</strong> ${f.bld_type}<br>
      <strong>業務面積:</strong> ${f.business_area}<br>
      <strong>住宅面積:</strong> ${f.residential_area}
    `)
  );

  importantFacilityLayer = L.layerGroup(markers);

  const toggle = document.getElementById("toggleImportantFacilities");
  if (toggle && toggle.checked) {
    importantFacilityLayer.addTo(map);
  }
}

// === Parse Trips CSV ===
function parseTripsCSV(csvString) {
  const lines = csvString.trim().split('\n');
  const headers = lines[0].split(',');
  const tripsByPerson = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const trip = Object.fromEntries(headers.map((h, j) => [h.trim(), cols[j].trim()]));
    const personId = trip.person_id;

    if (!tripsByPerson[personId]) tripsByPerson[personId] = [];

    tripsByPerson[personId].push({
      startActivity: trip.start_act,
      endActivity: trip.end_act,
      mode: trip.leg_mode,
      departureTime: trip.departure_time,
      arrivalTime: trip.arrival_time,
      distance: parseFloat(trip.distance)
    });
  }

  return Object.entries(tripsByPerson).map(([personId, trips]) => ({ personId, trips }));
}

// === Parse Plans XML ===
function parsePlansXML(xmlDoc, limit = Infinity) {
  const persons = xmlDoc.getElementsByTagName("person");
  const result = [];

  for (let i = 0; i < Math.min(persons.length, limit); i++) {
    const person = persons[i];
    const id = person.getAttribute("id");
    const plan = Array.from(person.getElementsByTagName("plan")).find(p => p.getAttribute("selected") === "yes");
    if (!plan) continue;

    const chain = [];
    let currentTime = "00:00:00";

    for (let node of plan.children) {
      if (node.tagName === "act") {
        const end = node.getAttribute("end_time");
        chain.push({
          type: node.getAttribute("type"),
          startTime: currentTime,
          endTime: end || null
        });
        currentTime = end || currentTime;
      } else if (node.tagName === "leg") {
        chain.push({
          legMode: node.getAttribute("mode"),
          departureTime: currentTime,
          arrivalTime: null
        });
      }
    }

    for (let j = 0; j < chain.length - 1; j++) {
      if (chain[j].legMode && chain[j + 1].startTime) {
        chain[j].arrivalTime = chain[j + 1].startTime;
      }
    }

    result.push({ personId: id, plan: chain });
  }

  return result;
}

// === Display bus links ===
function displayBusLinks(features) {
  if (busLayer) {
    map.removeLayer(busLayer);
  }

  busLayer = L.geoJSON(features, {
    style: {
      color: "#FF6600",
      weight: 3,
      opacity: 0.9
    },
    onEachFeature: (feature, layer) => {
      layer.bindPopup(`Link ID: ${feature.properties.id}<br>Modes: ${feature.properties.modes}`);
    }
  });

  const showBus = document.getElementById("toggleBusRoutes");
  if (showBus && showBus.checked) {
    busLayer.addTo(map);
    if (features.length > 0) {
      map.fitBounds(busLayer.getBounds());
    }
  }
}

// === Toggle checkboxes ===
document.getElementById("toggleBusRoutes").addEventListener("change", (e) => {
  if (e.target.checked && busRouteFeatures.length > 0) {
    displayBusLinks(busRouteFeatures);
  } else if (busLayer) {
    map.removeLayer(busLayer);
  }
});

document.getElementById("toggleFacilityHeatmap").addEventListener("change", (e) => {
  if (e.target.checked && facilityLayer) {
    facilityLayer.addTo(map);
  } else if (facilityLayer) {
    map.removeLayer(facilityLayer);
  }
});

document.getElementById("toggleImportantFacilities").addEventListener("change", (e) => {
  if (e.target.checked && importantFacilityLayer) {
    importantFacilityLayer.addTo(map);
  } else if (importantFacilityLayer) {
    map.removeLayer(importantFacilityLayer);
  }
});
