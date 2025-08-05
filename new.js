for output plans:

// === Folder Upload Listener ===
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

  if (fileMap["output_plans.xml.gz"]) {
    const xml = await decompressGZToXML(fileMap["output_plans.xml.gz"]);
    const parsedPlans = parsePlansXML(xml, 100); // Limit to 100 persons
    console.log("Parsed Plans:", parsedPlans);
  } else {
    alert("output_plans.xml.gz not found in the uploaded folder.");
  }

  spinner.style.display = "none";
  if (labelText) labelText.textContent = "✅ Plans Loaded";
});

// === GZ Decompression ===
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

// === Parse output_plans.xml.gz ===
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
      if (node.tagName === "act" || node.tagName === "activity") {
        const end = node.getAttribute("end_time");
        const type = node.getAttribute("type");
        chain.push({
          personId: id,
          type,
          startTime: currentTime,
          endTime: end || null
        });
        currentTime = end || currentTime;
      } else if (node.tagName === "leg") {
        const mode = node.getAttribute("mode");
        const travTime = node.getAttribute("trav_time") || null;
        chain.push({
          personId: id,
          legMode: mode,
          departureTime: currentTime,
          travelTime: travTime
        });
      }
    }

    result.push({ personId: id, plan: chain });
  }

  return result;
}





















// === 0. Global layer and data storage ===
let busLayer = null;
let busRouteFeatures = [];
console.log(typeof proj4); // Should log 'function' if proj4 is loaded correctly
// === Define custom projection EPSG:6671 ===
proj4.defs("EPSG:6671", "+proj=tmerc +lat_0=33 +lon_0=129.5 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs");

// === 1. Handle file upload and parse the network XML ===
document.getElementById("networkUpload").addEventListener("change", (event) => {
  const file = event.target.files[0];
  const labelText = document.getElementById("uploadLabelText");
  const spinner = document.getElementById("uploadSpinner");

  if (!file || file.name !== "output_network.xml.gz") {
    alert("Please upload a file named output_network.xml.gz");
    return;
  }

  labelText.textContent = "読み込み中...";
  spinner.style.display = "inline";

  readGZXML(file).then(xml => {
    busRouteFeatures = parseNetworkXML(xml);

    labelText.textContent = "🚌 ネットワーク読込";
    spinner.style.display = "none";

    if (busRouteFeatures.length === 0) {
      alert("No bus routes found in the uploaded network file.");
      return;
    }

    const toggle = document.getElementById("toggleBusRoutes");
    toggle.checked = true;

    displayBusLinks(busRouteFeatures);
  }).catch(err => {
    labelText.textContent = "🚌 ネットワーク読込";
    spinner.style.display = "none";
    alert("Error reading network file: " + err);
  });
});

// === 2. Toggle checkbox to show/hide bus routes ===
document.getElementById("toggleBusRoutes").addEventListener("change", (e) => {
  const checked = e.target.checked;
  if (checked && busRouteFeatures.length > 0) {
    displayBusLinks(busRouteFeatures);
  } else if (busLayer) {
    map.removeLayer(busLayer);
  }
});

// === 3. Read and decompress GZipped XML ===
function readGZXML(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const compressed = new Uint8Array(e.target.result);
        const decompressed = pako.ungzip(compressed, { to: "string" });
        const xml = new DOMParser().parseFromString(decompressed, "text/xml");
        resolve(xml);
      } catch (err) {
        reject("Decompression error: " + err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

// === 4. EPSG:6671 to WGS84 transformation ===
function atlantisToWGS84(x, y) {
  try {
    const [lon, lat] = proj4("EPSG:6671", "EPSG:4326", [x, y]);
    return [lon, lat];
  } catch (e) {
    console.error("Projection failed:", e, x, y);
    return [0, 0]; // fallback to avoid map crashing
  }
}

// === 5. Parse network XML and return GeoJSON-like features (bus-only) ===
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

  console.log("Parsed node count:", Object.keys(nodes).length);

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

  console.log("Parsed bus link count:", features.length);
  return features;
}

// === 6. Display bus links on Leaflet map ===
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
      const bounds = busLayer.getBounds();
      console.log("Bus layer bounds:", bounds.toBBoxString());
      map.fitBounds(bounds);
    }
  }
}
