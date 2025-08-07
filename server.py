from flask import Flask, request, jsonify
from flask_cors import CORS  # ✅ Import this

app = Flask(__name__)
CORS(app)  # ✅ Allow all origins by default

@app.route("/upload", methods=["POST"])
def upload_file():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file uploaded"}), 400

    print("Received file:", file.filename)

    import gzip
    import xml.etree.ElementTree as ET

    with gzip.open(file.stream, "rt", encoding="utf-8") as f:
        context = ET.iterparse(f, events=("start", "end"))
        result = []
        count = 0

        for event, elem in context:
            if event == "start" and elem.tag == "person":
                personId = elem.attrib.get("id")
                plan_data = []

            elif event == "end" and elem.tag == "plan" and elem.attrib.get("selected") == "yes":
                currentTime = "00:00:00"
                for child in elem:
                    if child.tag in ("act", "activity"):
                        plan_data.append({
                            "personId": personId,
                            "type": child.attrib.get("type"),
                            "startTime": currentTime,
                            "endTime": child.attrib.get("end_time")
                        })
                        currentTime = child.attrib.get("end_time") or currentTime
                    elif child.tag == "leg":
                        plan_data.append({
                            "personId": personId,
                            "legMode": child.attrib.get("mode"),
                            "departureTime": currentTime,
                            "travelTime": child.attrib.get("trav_time")
                        })

                result.append({"personId": personId, "plan": plan_data})
                count += 1
                if count >= 100:
                    break

            elif event == "end" and elem.tag == "person":
                elem.clear()

        return jsonify(result)

if __name__ == "__main__":
    app.run(debug=True)
