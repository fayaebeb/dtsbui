// === 0. Global layer and data storage ===
let busLayer = null;
let busRouteFeatures = [];

proj4.defs("EPSG:6676", "+proj=tmerc +lat_0=36 +lon_0=133.5 +k=0.9999 +x_0=0 +y_0=0 +datum=GRS80 +units=m +no_defs");

// === 1. Handle file upload and parse the network XML ===
document.getElementById("networkUpload").addEventListener("change", (event) => {
  const file = event.target.files[0];
  const labelText = document.getElementById("uploadLabelText");
  const spinner = document.getElementById("uploadSpinner");

  if (!file || file.name !== "output_network.xml.gz") {
    alert("Please upload a file named output_network.xml.gz");
    return;
  }

  // Show loading feedback inside button
  labelText.textContent = "読み込み中...";
  spinner.style.display = "inline";

  readGZXML(file).then(xml => {
    busRouteFeatures = parseNetworkXML(xml);

    // Hide spinner and reset button label
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

// === 4. Atlantis to WGS84 transformation ===
function atlantisToWGS84(x, y) {
  const [lon, lat] = proj4("EPSG:6676", "EPSG:4326", [x, y]);
  return [lon, lat];
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

// === 6. Display bus links on Leaflet map ===
function displayBusLinks(features) {
  if (busLayer) {
    map.removeLayer(busLayer);
  }

  busLayer = L.geoJSON(features, {
    style: {
      color: "#FF6600", // Highlight bus links
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