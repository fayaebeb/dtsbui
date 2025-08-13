# story_api.py
import os
from flask import Blueprint, request, jsonify
from openai import OpenAI

# Keep this module independent to avoid circular imports
DEFAULT_WEIGHTS = {
    "act": {"Home": 1.0, "Work": 0.5, "Business": 0.3, "Shopping": 0.2, "__other__": 0.1},
    "leg": {"car": -2.0, "walk": 0.5, "pt": 0.1, "__other__": 0.0},
}

client = OpenAI()  # reads OPENAI_API_KEY from env
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

story_bp = Blueprint("story_bp", __name__)

@story_bp.route("/story", methods=["POST"])
def generate_story():
    """
    Body: {
      "personId": str,
      "plan": { "steps": [...] },   # ONE plan (already chosen)
      "weights": { "act": {...}, "leg": {...} }   # optional
    }
    Returns: { "title": str, "one_liner": str, "bubbles": [str, ...] }
    """
    data = request.get_json(force=True) or {}
    person_id = data.get("personId")
    plan = data.get("plan") or {}
    steps = plan.get("steps") or []
    weights = data.get("weights") or DEFAULT_WEIGHTS

    # compact steps to keep token usage low
    def step_to_line(s):
        if s.get("kind") == "activity":
            return f'ACT {s.get("type","?")} {s.get("startTime","-")}→{s.get("endTime","-")} dur={s.get("durationSec")}'
        return f'LEG {s.get("mode","?")} dep={s.get("depTime","-")} tt={s.get("durationSec")}'
    lines = [step_to_line(s) for s in steps[:80]]

    resp = client.responses.create(
        model=OPENAI_MODEL,
        input=[
            {
                "role": "system",
                "content": (
                    "You write short, concrete, optimistic stories about a single day "
                    "from a transport simulation. Language: Japanese. Audience: general public. "
                    "Stay factual to the provided steps."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"personId: {person_id}\n"
                    f"Weights(act/leg): {weights}\n"
                    "Plan steps (chronological):\n" + "\n".join(lines) + "\n\n"
                    "TASK: Output JSON with fields:\n"
                    "- title (<= 18 chars)\n"
                    "- one_liner (<= 60 chars)\n"
                    "- bubbles (3-5 items, each <= 28 chars)"
                ),
            },
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "StoryPayload",
                "schema": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "one_liner": {"type": "string"},
                        "bubbles": {
                            "type": "array",
                            "items": {"type": "string"},
                            "minItems": 3,
                            "maxItems": 5
                        }
                    },
                    "required": ["title", "one_liner", "bubbles"],
                    "additionalProperties": False
                },
                "strict": True
            }
        },
    )

    # Prefer parsed output; fall back to raw JSON text
    msg = resp.output[0]
    payload = getattr(msg, "parsed", None) or {}
    if not payload:
        import json
        try:
            payload = json.loads(getattr(msg, "content", [{}])[0].text)
        except Exception:
            payload = {"title": "シミュ結果", "one_liner": "AI生成に失敗しました", "bubbles": []}

    return jsonify(payload)
