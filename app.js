document.getElementById("folderUpload").addEventListener("change", async (event) => {
  const files = Array.from(event.target.files);
  const fileMap = {};
  for (let file of files) {
    fileMap[file.name] = file;
  }

  if (fileMap["output_plans.xml.gz"]) {
    const formData = new FormData();
    formData.append("file", fileMap["output_plans.xml.gz"]);

    const spinner = document.getElementById("folderUploadSpinner");
    const labelText = document.getElementById("folderUploadLabel");
    spinner.style.display = "inline";
    labelText.textContent = "Uploading to server...";

    try {
      const res = await fetch("http://127.0.0.1:5000/upload", {
        method: "POST",
        body: formData
      });

      const parsedPlans = await res.json();
      console.log("Parsed on server:", parsedPlans);

      displayPlansOnMap(parsedPlans); // ✅ Added this

      labelText.textContent = "✅ Plans Loaded";
    } catch (err) {
      console.error(err);
      alert("Upload failed.");
      labelText.textContent = "❌ Error";
    } finally {
      spinner.style.display = "none";
    }
  } else {
    alert("output_plans.xml.gz not found in the uploaded folder.");
  }
});

// === Coordinate Projection ===
proj4.defs("EPSG:6671", "+proj=tmerc +lat_0=36 +lon_0=132.1666666666667 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs");

function atlantisToWGS84(x, y) {
  try {
    const [lon, lat] = proj4("EPSG:6671", "EPSG:4326", [x, y]);
    return [lon, lat];
  } catch (e) {
    console.error("Projection failed:", e, x, y);
    return [0, 0];
  }
}

// === Display Plans on Map ===
function displayPlansOnMap(parsedPlans) {
  const colorMap = {
    Home: "blue",
    Work: "green",
    Business: "orange",
    Shopping: "purple",
    "pt interaction": "gray"
  };

  parsedPlans.forEach(person => {
    const points = [];

    person.plan.forEach(step => {
      if (step.type && step.x !== null && step.y !== null) {
        const [lon, lat] = atlantisToWGS84(step.x, step.y);
        points.push([lat, lon]);

        L.circleMarker([lat, lon], {
          radius: 4,
          color: colorMap[step.type] || "black",
          fillOpacity: 0.8
        })
          .bindPopup(`<strong>${step.type}</strong><br>${person.personId}`)
          .addTo(map);
      }
    });

    if (points.length >= 2) {
      L.polyline(points, { color: "blue", weight: 2 }).addTo(map);
    }
  });
}