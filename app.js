// === 0. Global layer and data storage ===
let busLayer = null;
let busRouteFeatures = [];
console.log(typeof proj4); // Should log 'function' if proj4 is loaded correctly

proj4.defs("EPSG:6671", "+proj=tmerc +lat_0=36 +lon_0=132.1666666666667 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs");

// === Folder Upload Handling ===
document.getElementById("folderUpload").addEventListener("change", async (event) => {
  const files = Array.from(event.target.files);
  const spinner = document.getElementById("folderUploadSpinner");
  spinner.style.display = "inline";

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
      scenarioData.plans = parsePlansXML(xml, 100); // Parse only first 100 persons
    }
  }

  if (fileMap["output_network.xml.gz"]) {
    const xml = await decompressGZToXML(fileMap["output_network.xml.gz"]);
    scenarioData.network = parseNetworkXML(xml);
    busRouteFeatures = scenarioData.network;
    displayBusLinks(scenarioData.network);
  }

  spinner.style.display = "none";
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
    return [0, 0]; // fallback to avoid map crashing
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

// === Parse Plans XML (limit number of persons) ===
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

// === Display bus links on Leaflet map ===
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

// === Toggle checkbox to show/hide bus routes ===
document.getElementById("toggleBusRoutes").addEventListener("change", (e) => {
  const checked = e.target.checked;
  if (checked && busRouteFeatures.length > 0) {
    displayBusLinks(busRouteFeatures);
  } else if (busLayer) {
    map.removeLayer(busLayer);
  }
});
