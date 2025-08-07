from flask import Flask, request, jsonify
from flask_cors import CORS
import gzip
import xml.etree.ElementTree as ET

app = Flask(__name__)
CORS(app)

def parse_time_to_seconds(time_str):
    if not time_str:
        return None
    try:
        h, m, s = map(int, time_str.split(":"))
        return h * 3600 + m * 60 + s
    except Exception:
        return None

@app.route("/upload", methods=["POST"])
def upload_file():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file uploaded"}), 400

    with gzip.open(file.stream, "rt", encoding="utf-8") as f:
        context = ET.iterparse(f, events=("start", "end"))

        result = []
        current_person = None
        inside_selected_plan = False
        current_plan = []
        current_time = "00:00:00"

        for event, elem in context:
            tag = elem.tag

            if event == "start":
                if tag == "person":
                    current_person = {
                        "personId": elem.attrib.get("id"),
                        "plan": []
                    }

                elif current_person is not None:
                    if tag == "plan" and elem.attrib.get("selected") == "yes":
                        inside_selected_plan = True
                        current_plan = []
                        current_time = "00:00:00"

                    elif inside_selected_plan and tag in ("act", "activity"):
                        act_type = elem.attrib.get("type")
                        end_time = elem.attrib.get("end_time")
                        x = elem.attrib.get("x")
                        y = elem.attrib.get("y")

                        current_plan.append({
                            "type": act_type,
                            "startTime": current_time,
                            "endTime": end_time,
                            "x": float(x) if x else None,
                            "y": float(y) if y else None
                        })

                        current_time = end_time or current_time

                    elif inside_selected_plan and tag == "leg":
                        leg_mode = elem.attrib.get("mode")
                        travel_time = elem.attrib.get("trav_time")
                        current_plan.append({
                            "legMode": leg_mode,
                            "departureTime": current_time,
                            "travelTime": travel_time
                        })

            elif event == "end":
                if tag == "plan" and inside_selected_plan:
                    if current_person is not None:
                        current_person["plan"] = current_plan
                        result.append(current_person)
                    inside_selected_plan = False

                elif tag == "person":
                    current_person = None
                    elem.clear()

            if len(result) >= 50000:
                break

        return jsonify(result)

if __name__ == "__main__":
    app.run(debug=True)