import os
import json
import logging
import re
from typing import Any, Dict, List, Tuple, Optional
from collections import Counter, defaultdict
from threading import Lock

from flask import Blueprint, request, jsonify

try:
    from openai import AzureOpenAI  # type: ignore
except Exception:  # pragma: no cover
    AzureOpenAI = None  # type: ignore

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

MODE_LABELS: Dict[str, str] = {
    "car": "自家用車",
    "pt": "公共交通",
    "bus": "BRT",
    "walk": "徒歩",
    "transit_walk": "乗継徒歩",
    "bike": "自転車",
}

ACTIVITY_LABELS: Dict[str, str] = {
    "Home": "自宅",
    "Work": "仕事先",
    "Business": "立ち寄り先",
    "Shopping": "買い物先",
    "Education": "学校",
    "School": "学校",
    "Leisure": "余暇先",
}

_AZURE_OPENAI_CLIENT_LOCK = Lock()
_AZURE_OPENAI_CLIENT: Optional[Any] = None
_AZURE_OPENAI_CLIENT_WARNED = False


def _get_azure_openai_client_and_model() -> Tuple[Optional[Any], str]:
    """
    Azure OpenAI path using AZURE_OPENAI_* env vars.
    Returns (client, model_name). client is None when not configured.
    """
    global _AZURE_OPENAI_CLIENT, _AZURE_OPENAI_CLIENT_WARNED

    endpoint = _read_env("AZURE_OPENAI_ENDPOINT")
    key = _read_env("AZURE_OPENAI_KEY")
    model = _read_env("AZURE_OPENAI_MODEL")
    api_version = _read_env("AZURE_OPENAI_API_VERSION") or "2024-06-01"

    if not endpoint and not key and not model:
        return None, ""

    if AzureOpenAI is None:
        if not _AZURE_OPENAI_CLIENT_WARNED:
            logger.warning("openai package missing AzureOpenAI; cannot use AZURE_OPENAI_* configuration")
            _AZURE_OPENAI_CLIENT_WARNED = True
        return None, ""

    missing = []
    if not endpoint:
        missing.append("AZURE_OPENAI_ENDPOINT")
    if not key:
        missing.append("AZURE_OPENAI_KEY")
    if not model:
        missing.append("AZURE_OPENAI_MODEL")
    if missing:
        if not _AZURE_OPENAI_CLIENT_WARNED:
            logger.warning("Azure OpenAI configuration incomplete (missing: %s)", ", ".join(missing))
            _AZURE_OPENAI_CLIENT_WARNED = True
        return None, ""

    with _AZURE_OPENAI_CLIENT_LOCK:
        if _AZURE_OPENAI_CLIENT is not None:
            return _AZURE_OPENAI_CLIENT, model
        try:
            _AZURE_OPENAI_CLIENT = AzureOpenAI(
                api_key=key,
                azure_endpoint=endpoint,
                api_version=api_version,
                timeout=20,
                max_retries=2,
            )
        except Exception as exc:
            if not _AZURE_OPENAI_CLIENT_WARNED:
                logger.exception("Failed to initialize Azure OpenAI client: %s", exc)
                _AZURE_OPENAI_CLIENT_WARNED = True
            return None, ""
        return _AZURE_OPENAI_CLIENT, model


story_bp = Blueprint("story_bp", __name__)

# ---------------- utilities ----------------

def _read_env(name: str) -> str:
    return (os.getenv(name, "") or "").strip()

def _log_llm_request(
    provider: str,
    *,
    model: str,
    messages: List[Dict[str, Any]],
    response_format: Optional[Dict[str, Any]],
    temperature: float,
    max_tokens: int,
) -> None:
    payload = {
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": response_format,
        "messages": messages,
    }
    logger.info("%s request: %s", provider, json.dumps(payload, ensure_ascii=False))

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

def _mode_label(mode: Any) -> str:
    return MODE_LABELS.get(str(mode or ""), str(mode or "移動"))

def _activity_label(act_type: Any) -> str:
    return ACTIVITY_LABELS.get(str(act_type or ""), str(act_type or "目的地"))

def _trip_phrase(origin_type: Any, dest_type: Any) -> str:
    origin = str(origin_type or "")
    dest = str(dest_type or "")
    if origin == "Home" and dest in {"School", "Education"}:
        return "通学"
    if origin == "Home" and dest == "Work":
        return "通勤"
    if origin == "Home" and dest == "Shopping":
        return "買い物"
    return f"{_activity_label(origin or 'Home')}から{_activity_label(dest or 'Work')}まで"

def _primary_story_mode(stats: Dict[str, Any]) -> Optional[str]:
    travel = stats.get("travel_minutes_by_mode") or {}
    if not isinstance(travel, dict):
        return None
    preferred = ["car", "pt", "bus", "bike"]
    ranked = [(m, int(v)) for m, v in travel.items() if isinstance(v, int) and v > 0]
    if not ranked:
        return None
    ranked.sort(key=lambda item: item[1], reverse=True)
    for mode in preferred:
        if any(m == mode for m, _ in ranked):
            return mode
    return ranked[0][0]

def _first_trip_activity_pair(steps: List[Dict[str, Any]]) -> Tuple[Optional[str], Optional[str]]:
    acts = [
        s for s in (steps or [])
        if isinstance(s, dict)
        and s.get("kind") == "activity"
        and str(s.get("type") or "").strip().lower() != "pt interaction"
    ]
    if len(acts) < 2:
        return None, None
    return str(acts[0].get("type") or ""), str(acts[1].get("type") or "")

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
        if 600 <= dur <= 30 * 3600 and fs_sec > 0:
            fs_disp = stats.get("first_start_display"); le_disp = stats.get("last_end_display")
            if isinstance(fs_disp, str) and isinstance(le_disp, str):
                facts.append(f"{fs_disp}出発→{le_disp}帰宅")

    tmbm = stats.get("travel_minutes_by_mode") or {}
    for mode, mins in tmbm.items():
        try:
            m = int(mins)
            if 0 < m <= 240:
                facts.append(f"{_mode_label(mode)}合計{m}分")
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

def _plan_badge_fact(steps: List[Dict[str, Any]], stats: Dict[str, Any]) -> Optional[str]:
    origin_type, dest_type = _first_trip_activity_pair(steps)
    phrase = _trip_phrase(origin_type or "Home", dest_type or "Work")
    leg_counts = stats.get("leg_counts") or {}
    if int(leg_counts.get("pt", 0)) > 0:
        return f"{phrase}で公共交通利用"
    if int(leg_counts.get("car", 0)) > 0:
        return f"{phrase}で自家用車利用"
    return phrase if phrase else None

def _mode_breakdown_labels(stats: Dict[str, Any]) -> List[str]:
    travel = stats.get("travel_minutes_by_mode") or {}
    rows: List[Tuple[int, str]] = []
    for mode, mins in travel.items():
        m = _as_int(mins)
        if m is None or m <= 0:
            continue
        rows.append((m, f"{_mode_label(mode)}{m}分"))
    rows.sort(key=lambda item: item[0], reverse=True)
    return [label for _, label in rows[:3]]

def _activity_labels_for_story(steps: List[Dict[str, Any]]) -> List[str]:
    out: List[str] = []
    seen = set()
    for step in (steps or []):
        if not isinstance(step, dict) or step.get("kind") != "activity":
            continue
        raw = str(step.get("type") or "").strip()
        if not raw or raw.lower() == "pt interaction":
            continue
        label = _activity_label(raw)
        if label in seen:
            continue
        out.append(label)
        seen.add(label)
    return out[:4]

def _story_plan_context(steps: List[Dict[str, Any]], stats: Dict[str, Any]) -> Dict[str, Any]:
    origin_type, dest_type = _first_trip_activity_pair(steps)
    start_sec = stats.get("first_start_sec")
    end_sec = stats.get("last_end_sec")
    return {
        "tripPhrase": _trip_phrase(origin_type or "Home", dest_type or "Work"),
        "origin": _activity_label(origin_type) if origin_type else None,
        "destination": _activity_label(dest_type) if dest_type else None,
        "startTime": stats.get("first_start_display") if isinstance(start_sec, int) and start_sec > 0 else None,
        "endTime": stats.get("last_end_display") if isinstance(end_sec, int) and end_sec > 0 else None,
        "totalTravelMinutes": _as_int(stats.get("total_travel_minutes")),
        "mainMode": _mode_label(_primary_story_mode(stats) or stats.get("dominant_mode") or ""),
        "modeBreakdown": _mode_breakdown_labels(stats),
        "activities": _activity_labels_for_story(steps),
        "usesPublicTransport": bool(int((stats.get("leg_counts") or {}).get("pt", 0)) > 0),
        "usesCar": bool(int((stats.get("leg_counts") or {}).get("car", 0)) > 0),
    }

def _story_change_context(
    before_steps: List[Dict[str, Any]],
    before_stats: Optional[Dict[str, Any]],
    after_steps: List[Dict[str, Any]],
    after_stats: Dict[str, Any],
    compare_ctx: Optional[Dict[str, Any]],
    person_ctx: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    compare_data: Dict[str, Any] = compare_ctx if isinstance(compare_ctx, dict) else {}
    person_data: Dict[str, Any] = person_ctx if isinstance(person_ctx, dict) else {}
    before_mode = _primary_story_mode(before_stats or {}) if before_stats else None
    after_mode = _primary_story_mode(after_stats)
    before_total = _as_int((before_stats or {}).get("total_travel_minutes")) if before_stats else None
    after_total = _as_int(after_stats.get("total_travel_minutes"))
    params = compare_data.get("params") or {}
    old_f = _as_int(params.get("oldFrequency"))
    new_f = _as_int(params.get("newFrequency"))
    delta_wait = compare_data.get("deltaWaitMin")
    try:
        delta_wait_out = round(float(delta_wait), 1)
    except Exception:
        delta_wait_out = None

    return {
        "after": _story_plan_context(after_steps, after_stats),
        "before": _story_plan_context(before_steps, before_stats) if before_stats else None,
        "change": {
            "selectedPlanChanged": bool(person_data.get("changedPlan")),
            "mainModeChanged": (before_mode != after_mode) if before_stats else None,
            "travelMinutesChanged": (before_total != after_total) if before_stats and before_total is not None and after_total is not None else None,
            "beforeMainMode": _mode_label(before_mode) if before_mode else None,
            "afterMainMode": _mode_label(after_mode) if after_mode else None,
            "beforeTotalTravelMinutes": before_total,
            "afterTotalTravelMinutes": after_total,
            "frequencyChange": f"{old_f}本→{new_f}本" if old_f is not None and new_f is not None else None,
            "deltaWaitMinutes": delta_wait_out if delta_wait_out and delta_wait_out > 0 else None,
            "deltaScore": round(float(compare_data.get("deltaScore") or 0.0), 2),
        },
    }

def _as_int(v: Any) -> Optional[int]:
    try:
        n = float(v)
        if n != n:  # NaN
            return None
        return int(round(n))
    except Exception:
        return None

def _dedupe_keep_order(items: List[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for x in items:
        s = str(x or "").strip()
        if not s or s in seen:
            continue
        out.append(s)
        seen.add(s)
    return out

def _compare_story_facts(
    before_stats: Optional[Dict[str, Any]],
    after_stats: Dict[str, Any],
    compare_ctx: Optional[Dict[str, Any]],
    person_ctx: Optional[Dict[str, Any]],
    *,
    lang: str,
) -> Tuple[List[str], List[str]]:
    """
    Build additional approved/must-use facts from before/after and aggregate compare context.
    Returns (approved_extra, must_use_extra).
    """
    approved: List[str] = []
    must_use: List[str] = []

    if before_stats:
        b_total = _as_int(before_stats.get("total_travel_minutes"))
        a_total = _as_int(after_stats.get("total_travel_minutes"))
        if b_total is not None and a_total is not None and b_total != a_total:
            approved.append(f"移動合計{b_total}分→{a_total}分")
            must_use.append(f"移動合計{b_total}分→{a_total}分")

        b_modes = before_stats.get("travel_minutes_by_mode") or {}
        a_modes = after_stats.get("travel_minutes_by_mode") or {}
        for m in ("pt", "walk", "car"):
            b = _as_int(b_modes.get(m))
            a = _as_int(a_modes.get(m))
            if b is None or a is None or b == a:
                continue
            fact = f"{_mode_label(m)}合計{b}分→{a}分"
            approved.append(fact)

    if isinstance(person_ctx, dict):
        changed_plan = person_ctx.get("changedPlan")
        if isinstance(changed_plan, bool):
            approved.append("対象者の選択経路が変更" if changed_plan else "対象者の選択経路は維持")

    if isinstance(compare_ctx, dict):
        mode = str(compare_ctx.get("mode") or "")
        if mode == "frequency":
            params = compare_ctx.get("params") or {}
            old_f = _as_int(params.get("oldFrequency"))
            new_f = _as_int(params.get("newFrequency"))
            if old_f is not None and new_f is not None:
                fact = f"対象路線の運行頻度{old_f}本→{new_f}本"
                must_use.insert(0, fact)

    approved = _dedupe_keep_order(approved)
    must_use = _dedupe_keep_order(must_use)
    if lang == "en":
        # English path currently keeps same numeric facts for strict token safety.
        return approved, must_use
    return approved, must_use

def _core_facts(stats: Dict[str, Any], approved: List[str]) -> List[str]:
    """Pick 2–4 high-priority facts used to guide one_liner."""
    chosen: List[str] = []
    fs = stats.get("first_start_display"); le = stats.get("last_end_display")
    if isinstance(fs, str) and isinstance(le, str) and fs != "-" and le != "-" and fs != "00:00":
        pair = f"{fs}出発→{le}帰宅"
        if pair in approved:
            chosen.append(pair)
    dom = stats.get("dominant_mode"); tmbm = stats.get("travel_minutes_by_mode") or {}
    if dom and dom in tmbm and isinstance(tmbm[dom], int) and 0 < tmbm[dom] <= 240:
        cand = f"{_mode_label(dom)}合計{int(tmbm[dom])}分"
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

def _validate_payload(obj: Dict[str, Any]) -> Dict[str, str]:
    if not isinstance(obj, dict):
        raise ValueError("LLM response must be a JSON object")

    title = obj.get("title")
    one_liner = obj.get("one_liner")
    bubble = obj.get("bubble")

    if not isinstance(title, str) or not title:
        raise ValueError("LLM response field 'title' must be a non-empty string")
    if not isinstance(one_liner, str) or not one_liner:
        raise ValueError("LLM response field 'one_liner' must be a non-empty string")
    if not isinstance(bubble, str) or not bubble:
        raise ValueError("LLM response field 'bubble' must be a non-empty string")

    return {"title": title, "one_liner": one_liner, "bubble": bubble}

def _is_llm_provider_configured() -> bool:
    """Return True when Azure OpenAI is configured and available."""
    return (
        bool(_read_env("AZURE_OPENAI_ENDPOINT"))
        and bool(_read_env("AZURE_OPENAI_KEY"))
        and bool(_read_env("AZURE_OPENAI_MODEL"))
        and (AzureOpenAI is not None)
    )

# ---------------- route ----------------

@story_bp.route("/story", methods=["POST"])
def generate_story():
    """
    Body: {
      "personId": str,
      "plan": { "steps": [...] },   # ONE plan (already chosen)
      "beforePlan": { "steps": [...] },              # optional, for before→after narrative
      "weights": { "act": {...}, "leg": {...} },  # optional
      "compareContext": { ... },                     # optional aggregates before/after context
      "personContext": { ... },                      # optional metadata (changedPlan, scores, etc.)
      "lang": "ja" | "en"                         # optional
    }
    Returns: { "title": str, "one_liner": str, "bubble": str }
    """
    data = request.get_json(force=True) or {}
    person_id = data.get("personId")
    plan = data.get("plan") or {}
    steps = plan.get("steps") or []
    before_plan = data.get("beforePlan") or {}
    before_steps = before_plan.get("steps") or []
    weights = data.get("weights") or DEFAULT_WEIGHTS
    compare_ctx = data.get("compareContext") if isinstance(data.get("compareContext"), dict) else {}
    person_ctx = data.get("personContext") if isinstance(data.get("personContext"), dict) else {}
    lang = (data.get("lang") or "ja").lower()

    if not person_id or not isinstance(steps, list) or not steps:
        return jsonify({"error": "invalid payload"}), 400

    if not _is_llm_provider_configured():
        return jsonify({
            "error": (
                "Azure OpenAI is required but not configured. "
                "Set AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_KEY + AZURE_OPENAI_MODEL "
                "(optional: AZURE_OPENAI_API_VERSION), then restart the server."
            )
        }), 503

    _, stats = _summarize_plan(steps, cap=60)
    before_stats: Optional[Dict[str, Any]] = None
    if isinstance(before_steps, list) and before_steps:
        _, before_stats = _summarize_plan(before_steps, cap=40)

    normalized_ctx = _story_change_context(before_steps, before_stats, steps, stats, compare_ctx, person_ctx)

    approved_facts = []
    badge = _plan_badge_fact(steps, stats)
    if badge:
        approved_facts.append(badge)
    approved_facts.extend(_safe_facts(stats))
    approved_extra, must_extra = _compare_story_facts(before_stats, stats, compare_ctx, person_ctx, lang=lang)
    approved_facts = _dedupe_keep_order(approved_facts + approved_extra)[:14]

    must_use = _core_facts(stats, approved_facts)  # 2–4 prioritized facts
    if must_extra:
        must_use = _dedupe_keep_order(must_extra + must_use)[:6]

    def _llm_call() -> Dict[str, Any]:
        sys_msg = {
            "role": "system",
            "content": (
                "You write concrete, data-grounded first-person day-in-the-life blurbs in Japanese"
                " grounded ONLY in the given simulation data. "
                "Write as if the selected traveler is speaking naturally about their own day and how it changed. "
                "The tone should feel like a person talking about daily life, not a report or caption. "
                "Use first person voice in Japanese, such as '私は' or an implied first-person subject. "
                "Do not write analyst/report prose like 'この人物は', 'この人は', or 'personId'. "
                "Prefer natural openings such as '普段の通勤では...' or 'いつもの通学では...'. "
                "Do not start with compressed summary phrases like '通勤で公共交通を利用し'. "
                "Prefer simulation-safe change phrasing such as '運行頻度が増えてからは' or '以前より' instead of concrete time markers like '今日から'. "
                "Do not use raw technical labels like 'pt interaction' or 'transit_walk'; paraphrase them naturally. "
                "Avoid generic phrasing and avoid repeating the same fact twice. "
                "Do not introduce numeric values (times, counts, minutes) that are not listed as MUST-USE facts."
            ),
        }
        user_msg = {
            "role": "user",
            "content": (
                f"personId: {person_id}\n"
                f"Weights(act/leg): {json.dumps(weights, ensure_ascii=False)}\n\n"
                "Normalized traveler context (JSON):\n" + json.dumps(normalized_ctx, ensure_ascii=False) + "\n\n"
                "APPROVED facts (for 'bubble' enum):\n- " + "\n- ".join(approved_facts) + "\n\n"
                "MUST-USE facts for 'one_liner' (include AT LEAST TWO; use numbers/times VERBATIM):\n- " + "\n- ".join(must_use) + "\n\n"
                "Task: Return JSON {title, one_liner, bubble} only.\n"
                "- title ≤20 chars, punchy and neutral.\n"
                "- one_liner: exactly 2 sentences, 60–200 chars, NO line breaks. "
                "Prefer first-person narration and describe my day as if I am speaking. "
                "Sentence 1 should describe my usual trip in natural Japanese, preferably with a lived opening rather than a metric summary. "
                "Sentence 2 should explain how the service change affected that trip in first person.\n"
                "Prefer personal before/after change facts over whole-system metrics. Whole-system metrics are optional background only.\n"
                "Prefer a small lived narrative: usual trip -> what changed -> how it feels.\n"
                "Avoid report-like phrasing, metric recitation, and compressed factual openings.\n"
                "Avoid concrete calendar-like phrasing such as '今日から' unless the input explicitly gives a real date.\n"
                "If the selected plan did not change, do not invent a route or mode switch. Instead describe the same trip becoming easier, smoother, or less stressful because service improved.\n"
                "If time did not improve, do not claim it became shorter.\n"
                "If the person was already using public transport, describe improved ease, waiting burden, or peace of mind rather than a mode switch.\n"
                "Never use raw MATSim terms such as 'pt interaction'.\n"
                "Weave at least TWO of the MUST-USE facts naturally (use numbers/times exactly as written).\n"
                "- bubble: pick EXACTLY one from APPROVED facts, and prefer a personal trip fact over a system or route fact.\n"
            ),
        }

        response_format: Dict[str, Any] = {
            "type": "json_schema",
            "json_schema": {
                "name": "story_payload",
                "strict": True,
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "title": {"type": "string", "maxLength": 20, "pattern": r"^[^\n\r\t]{1,20}$"},
                        "one_liner": {"type": "string", "maxLength": 200, "pattern": r"^[^\n\r\t]{60,200}$"},
                        "bubble": {"type": "string", "maxLength": 28, "enum": approved_facts},
                    },
                    "required": ["title", "one_liner", "bubble"],
                },
            },
        }

        messages = [sys_msg, user_msg]
        client, model_name = _get_azure_openai_client_and_model()
        if client is None or not model_name:
            raise RuntimeError("Azure OpenAI is required but not configured")

        _log_llm_request(
            "Azure OpenAI",
            model=model_name,
            messages=messages,
            response_format=response_format,
            temperature=0.5,
            max_tokens=260,
        )
        resp = client.chat.completions.create(
            model=model_name,
            response_format=response_format,  # type: ignore[arg-type]
            messages=messages,  # type: ignore[arg-type]
            temperature=0.5,
            max_tokens=260,
        )
        raw = resp.choices[0].message.content or "{}"
        logger.info(
            "Azure OpenAI response (id=%s, model=%s): %s",
            getattr(resp, "id", None),
            getattr(resp, "model", model_name),
            raw,
        )
        return json.loads(raw)

    try:
        obj = _llm_call()
    except Exception as e:
        logger.exception("Azure OpenAI call failed: %s", e)
        return jsonify({"error": f"Azure OpenAI call failed: {e}"}), 500

    try:
        payload = _validate_payload(obj)
    except Exception as e:
        logger.exception("Invalid LLM response payload: %s", e)
        return jsonify({"error": f"Invalid Azure OpenAI response payload: {e}"}), 500

    logger.info("Story final payload: %s", json.dumps(payload, ensure_ascii=False))
    return jsonify(payload)
