# story_api.py
import os
import json
import logging
import re
from typing import Any, Dict, List, Tuple, Optional
from collections import Counter, defaultdict

from flask import Blueprint, request, jsonify
from openai import OpenAI

# --- logging setup ---
_LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
if not logging.getLogger().handlers:
    logging.basicConfig(level=getattr(logging, _LOG_LEVEL, logging.INFO))
logger = logging.getLogger(__name__)

# --- constants / defaults ---
DEFAULT_WEIGHTS: Dict[str, Dict[str, float]] = {
    "act": {"Home": 1.0, "Work": 0.5, "Business": 0.3, "Shopping": 0.2, "__other__": 0.1},
    "leg": {"car": -2.0, "walk": 0.5, "pt": 0.1, "__other__": 0.0},
}

client = OpenAI()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

story_bp = Blueprint("story_bp", __name__)

# ---------------- utilities ----------------

def _sec(x: Any) -> int:
    try:
        return max(0, int(float(x)))
    except Exception:
        return 0

def _parse_matsim_time_to_sec(s: Any) -> Optional[int]:
    """Accepts H:MM[:SS] where H may be >= 0 (MATSim allows >24h). -> seconds or None."""
    if not isinstance(s, str) or not s:
        return None
    try:
        parts = s.split(":")
        if not (1 <= len(parts) <= 3):
            return None
        h = int(parts[0])
        m = int(parts[1]) if len(parts) >= 2 else 0
        sec = int(parts[2]) if len(parts) == 3 else 0
        if not (0 <= m < 60 and 0 <= sec < 60 and h >= 0):
            return None
        return h * 3600 + m * 60 + sec
    except Exception:
        return None

def _display_time_hhmm(total_sec: int) -> str:
    """If <24h: HH:MM, else: 翌HH:MM (next-day clock)."""
    day = 24 * 3600
    if total_sec < 0:
        total_sec = 0
    if total_sec < day:
        hh = total_sec // 3600
        mm = (total_sec % 3600) // 60
        return f"{hh:02d}:{mm:02d}"
    else:
        rem = total_sec % day
        hh = rem // 3600
        mm = (rem % 3600) // 60
        return f"翌{hh:02d}:{mm:02d}"

def _summarize_plan(steps: List[Dict[str, Any]], cap: int = 60) -> Tuple[List[str], Dict[str, Any]]:
    """Return (lines, stats)."""
    lines: List[str] = []
    acts: Counter[str] = Counter()
    legs: Counter[str] = Counter()
    dur_by_mode: Dict[str, int] = defaultdict(int)
    total_travel: int = 0
    first_start_sec: Optional[int] = None
    last_end_sec: Optional[int] = None
    first_start_raw: Optional[str] = None
    last_end_raw: Optional[str] = None

    for s in (steps or []):
        if s.get("kind") == "activity":
            act_type = str(s.get("type", "?"))
            acts[act_type] += 1
            st = s.get("startTime"); et = s.get("endTime")
            st_sec = _parse_matsim_time_to_sec(st)
            et_sec = _parse_matsim_time_to_sec(et)
            if first_start_sec is None and st_sec is not None:
                first_start_sec = st_sec; first_start_raw = st
            if et_sec is not None:
                last_end_sec = et_sec; last_end_raw = et
        else:
            mode = str(s.get("mode", "?"))
            legs[mode] += 1
            d = _sec(s.get("durationSec"))
            dur_by_mode[mode] += d
            total_travel += d

    # small chronological sample
    for s in (steps or [])[:cap]:
        if s.get("kind") == "activity":
            lines.append(f'ACT {s.get("type","?")} {s.get("startTime","-")}→{s.get("endTime","-")}')
        else:
            lines.append(f'LEG {s.get("mode","?")} tt={_sec(s.get("durationSec"))}s')

    def to_minutes(sec: int) -> int:
        return int(round(sec / 60.0)) if sec else 0

    dominant_mode: Optional[str] = max(legs, key=lambda k: legs[k]) if legs else None
    dominant_activity: Optional[str] = max(acts, key=lambda k: acts[k]) if acts else None

    stats: Dict[str, Any] = {
        "first_start": first_start_raw or "-",
        "last_end": last_end_raw or "-",
        "first_start_sec": first_start_sec,
        "last_end_sec": last_end_sec,
        "first_start_display": _display_time_hhmm(first_start_sec) if first_start_sec is not None else "-",
        "last_end_display": _display_time_hhmm(last_end_sec) if last_end_sec is not None else "-",
        "activity_counts": dict(acts),
        "leg_counts": dict(legs),
        "travel_minutes_by_mode": {k: to_minutes(v) for k, v in dur_by_mode.items()},
        "total_travel_minutes": to_minutes(total_travel),
        "distinct_activities": list(acts.keys()),
        "dominant_mode": dominant_mode,
        "dominant_activity": dominant_activity,
    }
    return lines, stats

def _safe_facts(stats: Dict[str, Any]) -> List[str]:
    """Concrete, plausible, *true* facts to choose from (short)."""
    facts: List[str] = []

    fs_sec = stats.get("first_start_sec"); le_sec = stats.get("last_end_sec")
    if isinstance(fs_sec, int) and isinstance(le_sec, int):
        dur = le_sec - fs_sec
        if 600 <= dur <= 30 * 3600:
            fs_disp = stats.get("first_start_display"); le_disp = stats.get("last_end_display")
            if isinstance(fs_disp, str) and isinstance(le_disp, str):
                facts.append(f"{fs_disp}出発→{le_disp}帰宅")

    tmbm = stats.get("travel_minutes_by_mode") or {}
    mode_label = {"walk": "徒歩", "pt": "公共交通", "car": "自動車"}
    for mode, mins in tmbm.items():
        try:
            m = int(mins)
            if 0 < m <= 240:
                facts.append(f"{mode_label.get(mode, mode)}合計{m}分")
        except Exception:
            pass

    tt = stats.get("total_travel_minutes")
    if isinstance(tt, int) and 0 < tt <= 360:
        facts.append(f"移動合計{tt}分")

    leg_counts = stats.get("leg_counts") or {}
    acts = stats.get("activity_counts") or {}
    if int(acts.get("Shopping", 0)) >= 1 and int(acts.get("Work", 0)) >= 1:
        facts.append("仕事帰りに買物立寄り")
    if int(leg_counts.get("pt", 0)) >= 2:
        facts.append("公共交通を複数回利用")

    return (facts[:8] or ["今日の移動をひとことで"])

def _core_facts(stats: Dict[str, Any], approved: List[str]) -> List[str]:
    """Pick 2–4 high-priority facts used to guide one_liner."""
    chosen: List[str] = []
    fs = stats.get("first_start_display"); le = stats.get("last_end_display")
    if isinstance(fs, str) and isinstance(le, str) and fs != "-" and le != "-":
        pair = f"{fs}出発→{le}帰宅"
        if pair in approved:
            chosen.append(pair)
    dom = stats.get("dominant_mode"); tmbm = stats.get("travel_minutes_by_mode") or {}
    if dom and dom in tmbm and isinstance(tmbm[dom], int) and 0 < tmbm[dom] <= 240:
        label = {"walk": "徒歩", "pt": "公共交通", "car": "自動車"}.get(dom, str(dom))
        cand = f"{label}合計{int(tmbm[dom])}分"
        if cand in approved and cand not in chosen:
            chosen.append(cand)
    tt = stats.get("total_travel_minutes")
    if isinstance(tt, int) and 0 < tt <= 360:
        cand = f"移動合計{tt}分"
        if cand in approved and cand not in chosen:
            chosen.append(cand)
    for f in approved:
        if f not in chosen:
            chosen.append(f)
        if len(chosen) >= 4:
            break
    return chosen[:4]

# ---------- numeric/time sanitization only ----------

_NUM_RE = re.compile(r"(翌?\d{2}:\d{2})|(\d{1,3})(?=分|時|回|本|km|m|%)")

def _extract_allowed_tokens(approved_facts: List[str]) -> Dict[str, set]:
    """Build a set of allowed times and numbers from approved facts."""
    allowed_times = set()
    allowed_nums = set()
    for f in approved_facts:
        for m in re.finditer(r"(翌?\d{2}:\d{2})", f):
            allowed_times.add(m.group(1))
        for m in re.finditer(r"(\d{1,3})(?=分|時|回|本|km|m|%)", f):
            allowed_nums.add(m.group(1))
    return {"times": allowed_times, "nums": allowed_nums}

def _sanitize_one_liner(text: str, approved_facts: List[str]) -> str:
    """Replace any numeric tokens not present in approved facts; normalize spacing/punct."""
    allowed = _extract_allowed_tokens(approved_facts)

    def _repl(m: re.Match) -> str:
        token = m.group(0)
        if ":" in token:  # time like 07:30 / 翌02:30
            return token if token in allowed["times"] else "ある時刻"
        else:  # plain number with unit
            num = m.group(0)
            return num if num in allowed["nums"] else "数"

    text = _NUM_RE.sub(_repl, text)
    text = re.sub(r"\s{2,}", " ", text)
    text = text.replace(" ，", "、").replace(" 。", "。").strip(" 　")
    return text.strip()

def _sanitize_inline(s: str) -> str:
    s = re.sub(r"[\r\n\t]+", " ", s or "")
    s = re.sub(r"\s{2,}", " ", s).strip()
    return s

def _validate_payload(obj: Dict[str, Any]) -> Dict[str, str]:
    def trunc(s: Any, n: int) -> str:
        return (str(s or "")).strip()[:n]
    title = trunc(obj.get("title", "AIストーリー"), 20)
    one_liner = trunc(obj.get("one_liner", ""), 200)
    bubble = trunc(obj.get("bubble", ""), 28) or "今日の変化をひとことで"
    title = _sanitize_inline(title)
    one_liner = _sanitize_inline(one_liner)
    bubble = _sanitize_inline(bubble)
    return {"title": title, "one_liner": one_liner, "bubble": bubble}

# ---------------- route ----------------

@story_bp.route("/story", methods=["POST"])
def generate_story():
    """
    Body: {
      "personId": str,
      "plan": { "steps": [...] },   # ONE plan (already chosen)
      "weights": { "act": {...}, "leg": {...} },  # optional
      "lang": "ja" | "en"                         # optional
    }
    Returns: { "title": str, "one_liner": str, "bubble": str }
    """
    data = request.get_json(force=True) or {}
    person_id = data.get("personId")
    plan = data.get("plan") or {}
    steps = plan.get("steps") or []
    weights = data.get("weights") or DEFAULT_WEIGHTS
    lang = (data.get("lang") or "ja").lower()
    sys_lang = "Japanese" if lang == "ja" else "English"

    if not person_id or not isinstance(steps, list) or not steps:
        return jsonify({"error": "invalid payload"}), 400

    lines, stats = _summarize_plan(steps, cap=60)
    approved_facts = _safe_facts(stats)
    must_use = _core_facts(stats, approved_facts)  # 2–4 prioritized facts

    try:
        # ---- Build request payload for the LLM ----
        messages = [
            {
                "role": "system",
                "content": (
                    "You write short, concrete, optimistic day-in-the-life blurbs "
                    "grounded ONLY in the given simulation data. "
                    f"Language: {sys_lang}. Audience: general public. "
                    "Style: concise but vivid, time-anchored. Do not use line breaks. "
                    "Do not introduce numeric values (times, counts, minutes) that are not listed as MUST-USE facts."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"personId: {person_id}\n"
                    f"Weights(act/leg): {json.dumps(weights, ensure_ascii=False)}\n\n"
                    "Chronology sample:\n" + "\n".join(lines) + "\n\n"
                    "Aggregated stats (JSON):\n" + json.dumps(stats, ensure_ascii=False) + "\n\n"
                    "APPROVED facts (for 'bubble' enum):\n- " + "\n- ".join(approved_facts) + "\n\n"
                    "MUST-USE facts for 'one_liner' (include AT LEAST TWO; use numbers/times VERBATIM):\n- " + "\n- ".join(must_use) + "\n\n"
                    "Task: Return JSON {title, one_liner, bubble} only.\n"
                    "- title ≤20 chars, punchy and neutral.\n"
                    "- one_liner: 2–3 sentences, 80–200 chars, NO line breaks. "
                    "Weave at least TWO of the MUST-USE facts naturally (use numbers/times exactly as written).\n"
                    "- bubble: pick EXACTLY one from APPROVED facts.\n"
                ),
            },
        ]

        response_format = {
            "type": "json_schema",
            "json_schema": {
                "name": "story_payload",
                "strict": True,
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "title": {
                            "type": "string",
                            "maxLength": 20,
                            "pattern": r"^[^\n\r\t]{1,20}$"
                        },
                        "one_liner": {
                            "type": "string",
                            "maxLength": 200,
                            "pattern": r"^[^\n\r\t]{80,200}$"
                        },
                        "bubble": {
                            "type": "string",
                            "maxLength": 28,
                            "enum": approved_facts
                        }
                    },
                    "required": ["title", "one_liner", "bubble"]
                }
            }
        }

        # ---- Log full context safely (DEBUG only) ----
        logger.debug("LLM context messages:\n%s", json.dumps(messages, ensure_ascii=False, indent=2))
        logger.debug("LLM response_format:\n%s", json.dumps(response_format, ensure_ascii=False, indent=2))

        # ---- Call LLM ----
        resp = client.chat.completions.create(
            model=OPENAI_MODEL,
            response_format=response_format,
            messages=messages,
            temperature=0.5,
            max_tokens=260,
            timeout=20,
        )

        # ---- Handle response ----
        raw = resp.choices[0].message.content or "{}"
        resp_id = getattr(resp, "id", None)
        model = getattr(resp, "model", OPENAI_MODEL)
        usage = getattr(resp, "usage", None)
        logger.info("LLM response (id=%s, model=%s): %s", resp_id, model, raw)
        if usage:
            try:
                logger.info("LLM usage: %s", usage)
            except Exception:
                pass

        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as je:
            logger.error("Failed to parse LLM JSON (id=%s): %s | raw=%r", resp_id, je, raw)
            obj = {"title": "シミュ結果", "one_liner": "AI応答の解析に失敗", "bubble": "今日の移動をひとことで"}

    except Exception as e:
        logger.exception("LLM call failed: %s", e)
        obj = {"title": "シミュ結果", "one_liner": "AI生成に失敗しました", "bubble": "今日の変化をひとことで"}

    # numeric/time cleanup (no tone/phrase filtering)
    payload = _validate_payload(obj)
    try:
        clean_one = _sanitize_one_liner(payload["one_liner"], approved_facts)
        # keep length floor if cleanup shortened it too much: lightly pad with safe facts
        if len(clean_one) < 80:
            # simple pad from must_use, without adding new numbers
            pad = " " + " ".join([f for f in must_use[:2] if f])
            clean_one = (clean_one + pad).strip()
        payload["one_liner"] = clean_one[:200]
    except Exception as _e:
        logger.warning("sanitize failed: %s", _e)

    return jsonify(payload)
