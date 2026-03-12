import os
import json
import logging
import re
from typing import Any, Dict, List, Tuple, Optional, Callable
from collections import Counter, defaultdict
from threading import Lock
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from flask import Blueprint, request, jsonify

try:
    from openai import OpenAI, AzureOpenAI  # type: ignore
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore
    AzureOpenAI = None  # type: ignore

try:
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider  # type: ignore
except Exception:  # pragma: no cover
    DefaultAzureCredential = None  # type: ignore
    get_bearer_token_provider = None  # type: ignore

try:
    from azure.ai.projects import AIProjectClient  # type: ignore
except Exception:  # pragma: no cover
    AIProjectClient = None  # type: ignore

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

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o")
FOUNDRY_MODEL = os.getenv("FOUNDRY_MODEL", OPENAI_MODEL).strip() or OPENAI_MODEL

_OPENAI_CLIENT_LOCK = Lock()
_OPENAI_CLIENT: Optional[Any] = None
_OPENAI_CLIENT_WARNED = False
_AZURE_OPENAI_CLIENT: Optional[Any] = None
_AZURE_OPENAI_CLIENT_WARNED = False

_FOUNDRY_TOKEN_LOCK = Lock()
_FOUNDRY_TOKEN: Optional[str] = None
_FOUNDRY_TOKEN_EXP: int = 0

def _get_openai_client() -> Optional[Any]:
    global _OPENAI_CLIENT, _OPENAI_CLIENT_WARNED
    if OpenAI is None:
        if not _OPENAI_CLIENT_WARNED:
            logger.warning("openai package not installed; skipping OpenAI client")
            _OPENAI_CLIENT_WARNED = True
        return None
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        if not _OPENAI_CLIENT_WARNED:
            logger.warning("OPENAI_API_KEY not configured; story endpoints disabled")
            _OPENAI_CLIENT_WARNED = True
        return None
    with _OPENAI_CLIENT_LOCK:
        if _OPENAI_CLIENT is not None:
            return _OPENAI_CLIENT
        try:
            _OPENAI_CLIENT = OpenAI(api_key=api_key, timeout=20, max_retries=2)
        except Exception as exc:
            if not _OPENAI_CLIENT_WARNED:
                logger.exception("Failed to initialize OpenAI client: %s", exc)
                _OPENAI_CLIENT_WARNED = True
            return None
        return _OPENAI_CLIENT


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

    with _OPENAI_CLIENT_LOCK:
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


def _get_openai_like_client_and_model() -> Tuple[Optional[Any], str, str]:
    """
    Unified OpenAI-family client selection.
    Priority:
      1) Azure OpenAI via AZURE_OPENAI_*
      2) OpenAI via OPENAI_API_KEY
    Returns (client, model_name, provider_label)
    """
    az_client, az_model = _get_azure_openai_client_and_model()
    if az_client is not None and az_model:
        return az_client, az_model, "Azure OpenAI"

    client = _get_openai_client()
    if client is not None:
        return client, OPENAI_MODEL, "OpenAI"
    return None, "", ""


story_bp = Blueprint("story_bp", __name__)

# ---------------- utilities ----------------

def _read_env(name: str) -> str:
    return (os.getenv(name, "") or "").strip()

def _is_foundry_project_endpoint(endpoint: str) -> bool:
    ep = (endpoint or "").lower()
    return "/api/projects/" in ep or ep.endswith("/api/projects") or "services.ai.azure.com/api/projects" in ep

def _get_foundry_bearer_token() -> Optional[str]:
    """
    Returns a bearer token suitable for Azure AI Foundry project endpoints.
    - If `FOUNDRY_BEARER_TOKEN` is set, use it directly.
    - Otherwise try `DefaultAzureCredential` with scope `https://ai.azure.com/.default`.
    """
    token_env = _read_env("FOUNDRY_BEARER_TOKEN")
    if token_env:
        return token_env

    global _FOUNDRY_TOKEN, _FOUNDRY_TOKEN_EXP
    with _FOUNDRY_TOKEN_LOCK:
        now = int(__import__("time").time())
        if _FOUNDRY_TOKEN and (_FOUNDRY_TOKEN_EXP - now) > 60:
            return _FOUNDRY_TOKEN

        if DefaultAzureCredential is None:
            return None
        try:
            cred = DefaultAzureCredential(exclude_interactive_browser_credential=True)
            tok = cred.get_token("https://ai.azure.com/.default")
            _FOUNDRY_TOKEN = tok.token
            _FOUNDRY_TOKEN_EXP = int(getattr(tok, "expires_on", now + 300) or (now + 300))
            return _FOUNDRY_TOKEN
        except Exception as exc:
            logger.warning("Failed to acquire Foundry bearer token via DefaultAzureCredential: %s", exc)
            return None

def _get_foundry_openai_client() -> Optional[Any]:
    """
    Preferred Foundry integration:
    - For Foundry *project* endpoints, use `azure-ai-projects` + Entra ID auth to create an OpenAI client.
    - For Azure OpenAI *resource* endpoints, use OpenAI SDK with Entra token provider or api-key.
    """
    endpoint = _read_env("FOUNDRY_ENDPOINT")
    if not endpoint:
        return None

    # 1) Foundry project endpoint: use AIProjectClient (Entra ID)
    if _is_foundry_project_endpoint(endpoint):
        if AIProjectClient is None or DefaultAzureCredential is None:
            logger.warning("Foundry project endpoint configured but azure-ai-projects/azure-identity not installed")
            return None
        try:
            cred = DefaultAzureCredential(exclude_interactive_browser_credential=True)
            project = AIProjectClient(endpoint=endpoint, credential=cred)
            api_version = _read_env("FOUNDRY_API_VERSION") or "2024-10-01-preview"
            return project.get_openai_client(api_version=api_version)
        except Exception as exc:
            logger.warning("Failed to create Foundry OpenAI client via project endpoint: %s", exc)
            return None

    # 2) Azure OpenAI resource endpoint: use OpenAI SDK directly
    if OpenAI is None:
        return None
    base_url = endpoint.rstrip("/")
    if not base_url.endswith("/openai/v1"):
        # Allow users to pass either the resource root or the full v1 base URL.
        if "openai.azure.com" in base_url and "/openai/" not in base_url:
            base_url = base_url.rstrip("/") + "/openai/v1"
    base_url = base_url.rstrip("/") + "/"

    # Prefer Entra ID; fall back to api-key if provided.
    if DefaultAzureCredential is not None and get_bearer_token_provider is not None:
        try:
            token_provider = get_bearer_token_provider(
                DefaultAzureCredential(exclude_interactive_browser_credential=True),
                "https://cognitiveservices.azure.com/.default",
            )
            return OpenAI(base_url=base_url, api_key=token_provider)
        except Exception as exc:
            logger.warning("Failed to create Azure OpenAI client with Entra token provider: %s", exc)

    key = _read_env("FOUNDRY_KEY")
    if key:
        try:
            return OpenAI(base_url=base_url, api_key=key)
        except Exception as exc:
            logger.warning("Failed to create Azure OpenAI client with api-key: %s", exc)
    return None

def _json_post(url: str, *, headers: Dict[str, str], payload: Dict[str, Any], timeout_sec: int = 30) -> Dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        if v is not None and str(v) != "":
            req.add_header(k, v)
    try:
        with urlopen(req, timeout=timeout_sec) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {}
    except HTTPError as e:
        raw = ""
        try:
            raw = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        try:
            obj = json.loads(raw) if raw else {}
        except Exception:
            obj = {"raw": raw}
        raise RuntimeError(f"HTTP {e.code} from LLM endpoint: {obj}") from None
    except URLError as e:
        raise RuntimeError(f"LLM endpoint unreachable: {e}") from None

def _foundry_candidates(endpoint: str, deployment_or_model: str, api_version: str) -> List[str]:
    base = (endpoint or "").rstrip("/")
    if not base:
        return []

    def with_api_version(u: str) -> str:
        if "api-version=" in u:
            return u
        join = "&" if "?" in u else "?"
        return f"{u}{join}api-version={api_version}"

    # If a full URL is already provided, use it as-is.
    if any(p in base for p in ("/chat/completions", "/completions")):
        return [with_api_version(base)]

    # Azure OpenAI resource endpoint (common)
    if "openai.azure.com" in base:
        dep = deployment_or_model
        return [with_api_version(f"{base}/openai/deployments/{dep}/chat/completions")]

    # Azure AI Foundry / Azure AI Inference endpoints (varies by deployment type)
    cands = [
        f"{base}/models/chat/completions",
        f"{base}/models/openai/chat/completions",
        f"{base}/chat/completions",
    ]
    return [with_api_version(u) for u in cands]

def _call_foundry_chat(*, messages: List[Dict[str, Any]], response_format: Optional[Dict[str, Any]] = None) -> Tuple[str, str]:
    """
    Call Azure AI Foundry / Azure OpenAI compatible chat completions endpoint.
    Returns (content, model_name).
    """
    endpoint = _read_env("FOUNDRY_ENDPOINT")
    key = _read_env("FOUNDRY_KEY")
    if not endpoint or not key:
        raise RuntimeError("FOUNDRY_ENDPOINT/FOUNDRY_KEY not configured")

    env_api_version = _read_env("FOUNDRY_API_VERSION")
    api_versions: List[str] = []
    if env_api_version:
        api_versions.append(env_api_version)
    if "services.ai.azure.com" in endpoint:
        api_versions.extend(["2024-05-01-preview", "2024-02-15-preview"])
    else:
        api_versions.extend(["2024-10-21", "2024-06-01", "2024-02-15-preview"])
    # Deduplicate while preserving order
    seen = set()
    api_versions = [v for v in api_versions if v and not (v in seen or seen.add(v))]

    deployment_or_model = _read_env("FOUNDRY_DEPLOYMENT") or FOUNDRY_MODEL

    req: Dict[str, Any] = {
        "messages": messages,
        "temperature": 0.5,
        "max_tokens": 260,
    }
    # Some endpoints require "model" and some use the deployment in the URL; include model for compatibility.
    if deployment_or_model:
        req["model"] = deployment_or_model

    if response_format:
        req["response_format"] = response_format

    foundry_chat_url = _read_env("FOUNDRY_CHAT_URL")

    auth_mode = (_read_env("FOUNDRY_AUTH") or "").lower()  # "key" | "token"
    wants_token = auth_mode == "token" or "/api/projects/" in endpoint or "services.ai.azure.com/api/projects" in endpoint
    bearer = _get_foundry_bearer_token() if wants_token else None

    headers: Dict[str, str] = {}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    if auth_mode != "token":
        # Many inference endpoints accept api-key; harmless to include even when bearer is used.
        headers["api-key"] = key

    last_err: Optional[Exception] = None
    for api_version in api_versions:
        candidates = [foundry_chat_url] if foundry_chat_url else _foundry_candidates(endpoint, deployment_or_model, api_version)
        for url in [u for u in candidates if u]:
            try:
                data = _json_post(url, headers=headers, payload=req, timeout_sec=30)
                content = (((data.get("choices") or [{}])[0]).get("message") or {}).get("content")
                if isinstance(content, str) and content.strip():
                    return content, str(data.get("model") or deployment_or_model or "foundry")
                raise RuntimeError(f"Unexpected LLM response shape: {data}")
            except Exception as e:
                last_err = e
                continue

    raise RuntimeError(f"All Foundry endpoint candidates failed: {last_err}")

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

    mode_label = {"walk": "徒歩", "pt": "公共交通", "car": "自動車"}

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
            label = mode_label.get(m, m)
            fact = f"{label}合計{b}分→{a}分"
            approved.append(fact)
            if m == "pt":
                must_use.append(fact)

    if isinstance(person_ctx, dict):
        changed_plan = person_ctx.get("changedPlan")
        if isinstance(changed_plan, bool):
            approved.append("対象者の選択経路が変更" if changed_plan else "対象者の選択経路は維持")

    if isinstance(compare_ctx, dict):
        mode = str(compare_ctx.get("mode") or "")
        pre = compare_ctx.get("pre") or {}
        post = compare_ctx.get("post") or {}

        pre_pt_users = _as_int(pre.get("ptUsers"))
        post_pt_users = _as_int(post.get("ptUsers"))
        if pre_pt_users is not None and post_pt_users is not None:
            fact = f"全体PT利用者{pre_pt_users}人→{post_pt_users}人"
            approved.append(fact)
            must_use.append(fact)

        pre_avg_sec = _as_int(pre.get("avgTravelSec"))
        post_avg_sec = _as_int(post.get("avgTravelSec"))
        if pre_avg_sec is not None and post_avg_sec is not None:
            pre_min = int(round(pre_avg_sec / 60.0))
            post_min = int(round(post_avg_sec / 60.0))
            approved.append(f"全体平均移動時間{pre_min}分→{post_min}分")

        changed_people = _as_int(compare_ctx.get("changedPeople"))
        if changed_people is not None:
            approved.append(f"経路変更人数{changed_people}人")
            if changed_people > 0:
                must_use.append(f"経路変更人数{changed_people}人")

        if mode == "frequency":
            params = compare_ctx.get("params") or {}
            old_f = _as_int(params.get("oldFrequency"))
            new_f = _as_int(params.get("newFrequency"))
            if old_f is not None and new_f is not None:
                fact = f"対象路線の運行頻度{old_f}本→{new_f}本"
                approved.append(fact)
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

_NUM_RE = re.compile(r"(翌?\d{2}:\d{2})|(\d{1,7})(?=分|時|回|本|km|m|%|人|秒)")

def _extract_allowed_tokens(approved_facts: List[str]) -> Dict[str, set]:
    """Build a set of allowed times and numbers from approved facts."""
    allowed_times = set()
    allowed_nums = set()
    for f in approved_facts:
        for m in re.finditer(r"(翌?\d{2}:\d{2})", f):
            allowed_times.add(m.group(1))
        for m in re.finditer(r"(\d{1,7})(?=分|時|回|本|km|m|%|人|秒)", f):
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

def _ensure_must_use_facts(text: str, must_use: List[str], *, min_count: int = 2, max_len: int = 200) -> str:
    base = _sanitize_inline(text)
    facts = [str(f or "").strip() for f in (must_use or []) if str(f or "").strip()]
    if not base or not facts or min_count <= 0:
        return base

    present = [f for f in facts if f in base]
    if len(present) >= min_count:
        return base

    missing = [f for f in facts if f not in base]
    need = max(0, min_count - len(present))
    inject = missing[:need]
    if not inject:
        return base

    joined = "、".join(inject)
    suffix = f" 主な変化: {joined}。"
    candidate = (base + suffix).strip()
    if len(candidate) <= max_len:
        return candidate

    while inject:
        inject.pop()
        if not inject:
            break
        joined = "、".join(inject)
        suffix = f" 主な変化: {joined}。"
        candidate = (base + suffix).strip()
        if len(candidate) <= max_len:
            return candidate
    return base[:max_len]


def _is_llm_provider_configured() -> bool:
    """Return True when at least one callable LLM provider is configured."""
    has_azure_openai = bool(_read_env("AZURE_OPENAI_ENDPOINT")) and bool(_read_env("AZURE_OPENAI_KEY")) and bool(_read_env("AZURE_OPENAI_MODEL")) and (AzureOpenAI is not None)
    has_openai = bool(os.getenv("OPENAI_API_KEY", "").strip()) and (OpenAI is not None)
    has_foundry = bool(_read_env("FOUNDRY_ENDPOINT")) and bool(
        _read_env("FOUNDRY_KEY") or _read_env("FOUNDRY_BEARER_TOKEN")
    )
    return has_azure_openai or has_openai or has_foundry

def _fallback_story(person_id: str, must_use: list[str], approved_facts: list[str], *, lang: str) -> Dict[str, str]:
    # Deterministic, dependency-free fallback for environments where the LLM cannot be called.
    fact1 = (must_use[0] if len(must_use) > 0 else "").strip()
    fact2 = (must_use[1] if len(must_use) > 1 else "").strip()
    bubble = (approved_facts[0] if approved_facts else "").strip()
    if not bubble:
        bubble = "今日の変化をひとことで" if lang == "ja" else "A quick takeaway"

    if lang == "en":
        title = "Daily story"
        parts = [p for p in [fact1, fact2] if p]
        core = ". ".join(parts) if parts else "A day-in-the-life summary based on the simulation."
        one_liner = (
            f"Person {person_id}: {core}. "
            "This is a local fallback summary because the AI service is unavailable."
        )
    else:
        title = "シミュ結果"
        parts = [p for p in [fact1, fact2] if p]
        core = "。".join(parts) + "。" if parts else "シミュレーション結果に基づく1日の要約です。"
        one_liner = (
            f"{person_id} の行動: {core}"
            "AIサービスが利用できないため、ローカル要約で表示しています。"
        )

    return _validate_payload({"title": title, "one_liner": one_liner, "bubble": bubble})

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
    sys_lang = "Japanese" if lang == "ja" else "English"

    if not person_id or not isinstance(steps, list) or not steps:
        return jsonify({"error": "invalid payload"}), 400

    if not _is_llm_provider_configured():
        return jsonify({
            "error": (
                "AI provider is not configured. "
                "Set AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_KEY + AZURE_OPENAI_MODEL "
                "(optional: AZURE_OPENAI_API_VERSION), or OPENAI_API_KEY, "
                "or FOUNDRY_ENDPOINT + FOUNDRY_KEY (or FOUNDRY_BEARER_TOKEN), "
                "then restart the server."
            )
        }), 503

    lines, stats = _summarize_plan(steps, cap=60)
    before_stats: Optional[Dict[str, Any]] = None
    before_lines: List[str] = []
    if isinstance(before_steps, list) and before_steps:
        before_lines, before_stats = _summarize_plan(before_steps, cap=40)

    approved_facts = _safe_facts(stats)
    approved_extra, must_extra = _compare_story_facts(before_stats, stats, compare_ctx, person_ctx, lang=lang)
    approved_facts = _dedupe_keep_order(approved_facts + approved_extra)[:14]

    must_use = _core_facts(stats, approved_facts)  # 2–4 prioritized facts
    if must_extra:
        must_use = _dedupe_keep_order(must_extra + must_use)[:6]

    def _llm_call() -> Dict[str, Any]:
        last_error: Optional[Exception] = None
        sys_msg = {
            "role": "system",
            "content": (
                "You write short, concrete, data-grounded day-in-the-life blurbs "
                "grounded ONLY in the given simulation data. "
                f"Language: {sys_lang}. Audience: general public. "
                "Style: concise and specific. Do not use line breaks. "
                "Avoid generic phrasing and avoid repeating the same fact twice. "
                "Do not introduce numeric values (times, counts, minutes) that are not listed as MUST-USE facts."
            ),
        }
        user_msg = {
            "role": "user",
            "content": (
                f"personId: {person_id}\n"
                f"Weights(act/leg): {json.dumps(weights, ensure_ascii=False)}\n\n"
                "Chronology sample:\n" + "\n".join(lines) + "\n\n"
                "Aggregated stats (JSON):\n" + json.dumps(stats, ensure_ascii=False) + "\n\n"
                "Before-change chronology sample (optional):\n" + ("\n".join(before_lines) if before_lines else "(none)") + "\n\n"
                "Before-change stats (optional JSON):\n" + (json.dumps(before_stats, ensure_ascii=False) if before_stats else "{}") + "\n\n"
                "Compare context (optional JSON):\n" + json.dumps(compare_ctx or {}, ensure_ascii=False) + "\n\n"
                "Person context (optional JSON):\n" + json.dumps(person_ctx or {}, ensure_ascii=False) + "\n\n"
                "APPROVED facts (for 'bubble' enum):\n- " + "\n- ".join(approved_facts) + "\n\n"
                "MUST-USE facts for 'one_liner' (include AT LEAST TWO; use numbers/times VERBATIM):\n- " + "\n- ".join(must_use) + "\n\n"
                "Task: Return JSON {title, one_liner, bubble} only.\n"
                "- title ≤20 chars, punchy and neutral.\n"
                "- one_liner: exactly 2 sentences, 60–200 chars, NO line breaks. "
                "Sentence 1 should describe the person's day and change. Sentence 2 should describe the simulation implication.\n"
                "Weave at least TWO of the MUST-USE facts naturally (use numbers/times exactly as written).\n"
                "- bubble: pick EXACTLY one from APPROVED facts.\n"
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

        # Prefer Azure OpenAI / OpenAI explicit configuration first.
        client, model_name, provider = _get_openai_like_client_and_model()
        if client is not None and model_name:
            try:
                resp = client.chat.completions.create(
                    model=model_name,
                    response_format=response_format,  # type: ignore[arg-type]
                    messages=messages,  # type: ignore[arg-type]
                    temperature=0.5,
                    max_tokens=260,
                )
                raw = resp.choices[0].message.content or "{}"
                logger.info("%s response (id=%s, model=%s): %s", provider or "OpenAI", getattr(resp, "id", None), getattr(resp, "model", model_name), raw)
                return json.loads(raw)
            except Exception as exc:
                last_error = exc
                logger.warning("%s call failed; trying Foundry fallback: %s", provider or "OpenAI", exc)

        foundry_client = _get_foundry_openai_client()
        if foundry_client is not None:
            model_name = _read_env("FOUNDRY_DEPLOYMENT") or FOUNDRY_MODEL
            try:
                resp = foundry_client.chat.completions.create(
                    model=model_name,
                    response_format=response_format,  # type: ignore[arg-type]
                    messages=messages,  # type: ignore[arg-type]
                    temperature=0.5,
                    max_tokens=260,
                )
                raw = resp.choices[0].message.content or "{}"
                logger.info(
                    "Foundry OpenAI SDK response (id=%s, model=%s): %s",
                    getattr(resp, "id", None),
                    getattr(resp, "model", model_name),
                    raw,
                )
                return json.loads(raw)
            except Exception as exc:
                last_error = exc
                logger.warning("Foundry OpenAI SDK call failed; falling back: %s", exc)

        # If Foundry is configured but the SDK path failed (common on App Service when
        # managed identity isn't enabled/authorized), try a direct REST call which
        # supports both api-key and bearer token auth.
        if _read_env("FOUNDRY_ENDPOINT") and _read_env("FOUNDRY_KEY"):
            try:
                content, model_used = _call_foundry_chat(messages=messages, response_format=response_format)
                logger.info("Foundry REST response (model=%s): %s", model_used, content)
                return json.loads(content or "{}")
            except Exception as exc:
                last_error = exc
                logger.warning("Foundry REST call failed; falling back: %s", exc)

        if last_error is not None:
            raise RuntimeError(f"No callable LLM provider succeeded: {last_error}")
        raise RuntimeError("No callable LLM provider succeeded")

    allow_local_fallback = str(os.getenv("STORY_ALLOW_LOCAL_FALLBACK", "0")).lower() in {"1", "true", "yes"}
    try:
        obj = _llm_call()
    except Exception as e:
        logger.exception("LLM call failed: %s", e)
        if not allow_local_fallback:
            return jsonify({"error": f"AI story generation failed: {e}"}), 502
        obj = _fallback_story(str(person_id), must_use, approved_facts, lang=lang)

    # numeric/time cleanup (no tone/phrase filtering)
    payload = _validate_payload(obj)
    try:
        clean_one = _sanitize_one_liner(payload["one_liner"], approved_facts)
        clean_one = _ensure_must_use_facts(clean_one, must_use, min_count=2, max_len=200)
        # keep length floor if cleanup shortened it too much: lightly pad with safe facts
        if len(clean_one) < 60:
            # simple pad from must_use, without adding new numbers
            pad = " " + " ".join([f for f in must_use[:2] if f])
            clean_one = (clean_one + pad).strip()
        payload["one_liner"] = clean_one[:200]
    except Exception as _e:
        logger.warning("sanitize failed: %s", _e)

    # Never return the local fallback marker as a successful AI response.
    if "AIサービスが利用できないため、ローカル要約で表示しています。" in str(payload.get("one_liner") or ""):
        return jsonify({"error": "AI backend returned local fallback text. Check provider configuration."}), 502

    return jsonify(payload)
