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
