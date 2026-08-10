"""Claude integration for the print-failure chat."""

import base64
import os

from anthropic import Anthropic

from . import config  # noqa: F401 — ensures .env is loaded before we read env vars

# Selectable in the UI (stored in the settings table); CLAUDE_MODEL in .env
# sets the default. Notes are shown to students next to the picker.
MODELS = [
    {
        "id": "claude-opus-5",
        "name": "Opus 5 — best quality (default)",
        "price": "$5 in / $25 out per million tokens",
        "notes": "Strongest diagnosis and photo understanding. Use for real "
                 "failures, anything involving photos, or when the cause isn't "
                 "obvious. With caching, a typical session costs cents.",
    },
    {
        "id": "claude-sonnet-5",
        "name": "Sonnet 5 — cheaper, near-Opus",
        "price": "$3 in / $15 out per million tokens",
        "notes": "About 40% cheaper and close to Opus on most print questions. "
                 "Good default if budget is tight; step up to Opus when a "
                 "diagnosis seems off or photos are subtle.",
    },
    {
        "id": "claude-haiku-4-5",
        "name": "Haiku 4.5 — fastest, weakest",
        "price": "$1 in / $5 out per million tokens",
        "notes": "Noticeably weaker reasoning and photo analysis — not "
                 "recommended for diagnosis. Fine for quick factual questions "
                 "('what does M722 do?').",
    },
]
MODEL_IDS = {m["id"] for m in MODELS}
DEFAULT_MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5")
MAX_TOKENS = 32000

_clients: dict[str, Anthropic] = {}


def get_client(api_key: str | None = None) -> Anthropic:
    """Lazy so the app can start (and the UI can explain what's missing)
    before an API key is configured. A UI-provided key overrides .env."""
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError(
            "No API key configured. Paste one via the 'API key' button in the "
            "app header, or put ANTHROPIC_API_KEY=sk-ant-... in the .env file "
            "next to the app and restart it.")
    if key not in _clients:
        _clients[key] = Anthropic(api_key=key)
    return _clients[key]


def verify_key(api_key: str) -> None:
    """Cheap validity check (token counting is free). Raises RuntimeError
    with a student-readable message if the key doesn't work."""
    import anthropic
    try:
        Anthropic(api_key=api_key).messages.count_tokens(
            model=DEFAULT_MODEL, messages=[{"role": "user", "content": "hi"}])
    except anthropic.AuthenticationError:
        raise RuntimeError("That key was rejected by Anthropic — check it was "
                           "copied completely (starts with sk-ant-).")
    except anthropic.APIConnectionError:
        raise RuntimeError("Could not reach api.anthropic.com — network problem, "
                           "not a key problem.")
    except anthropic.APIStatusError as e:
        raise RuntimeError(f"Key check failed: {e.message}")

SYSTEM = """\
You are the print-refinement assistant for a university metrology lab's \
ceramic paste-extrusion 3D printers (a Hyrel system driven by Repetrel on \
this PC; the lab also runs a Potterbot). Students bring you the G-code of a \
print plus their notes and photos. Sometimes the print failed outright; just \
as often it succeeded but needs tuning — over/under-extrusion, solids-loading \
effects, head travel speed vs extrusion rate balance, surface quality. Treat \
every session as process refinement, not only failure triage.

Help them:
- Interpret what they observed using paste-extrusion physics: slurry rheology \
and solids loading, drying shrinkage and cracking, under/over-extrusion, poor \
inter-filament or inter-layer bonding, nozzle clogs, priming/unpriming \
behavior, travel-move stringing, slumping, and machine-level causes. Explain \
which parameter changes have which effects, and their interactions (e.g. \
raising speed without raising flow starves the bead).
- Know the Hyrel dialect: flow is volumetric and pulse-based (M221 S \
multiplier, P pulses/uL, W width, Z height; M721 unprime / M722 prime pulse \
counts and dwells; M229 volumetric vs slicer-E mode). Also note that Repetrel \
sends head-dialog settings before streaming the file, so the file may not \
show every parameter actually used — ask the student for UI-set values when \
they matter.
- Propose concrete G-code edits and explain them so a student learns, not \
just copies. When you output modified G-code, put the complete edited file \
(or a clearly delimited edited section) in ONE ```gcode fenced block and \
list exactly which lines changed and why.

If the cause is ambiguous, say what evidence would settle it: a photo from a \
specific angle, a parameter to check in Repetrel, or a small test print. \
This lab is building a labeled defect dataset, so encourage precise \
observations (which layer, when in the print, what it looked like) and \
suggest appropriate observation tags for the record."""


def build_print_context(print_row: dict, printer_name: str, gcode_ctx: str) -> str:
    meta = {
        "print_id": print_row["id"],
        "printer": printer_name,
        "created_at": print_row["created_at"],
        "operator": print_row["operator"],
        "feedstock_batch": print_row["feedstock_batch"],
        "solids_loading_pct": print_row["solids_loading_pct"],
        "nozzle_diameter_mm": print_row["nozzle_diameter_mm"],
        "outcome": print_row["outcome"],
        "outcome_notes": print_row["outcome_notes"],
        "student_notes": print_row["notes"],
        "custom_fields": print_row.get("custom") or {},
        "parsed_gcode": print_row["params"],
    }
    return f"Print record:\n{meta}\n\n{gcode_ctx}"


def _image_block(data: bytes, media_type: str) -> dict:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": base64.standard_b64encode(data).decode(),
        },
    }


def chat(
    print_context: str,
    history: list[dict],
    user_message: str,
    images: list[tuple[bytes, str]] | None = None,
    lab_context: str = "",
    model: str | None = None,
    api_key: str | None = None,
) -> str:
    """Run one chat turn. history = [{role, content}] from the DB (text only).
    lab_context carries what the lab has learned so far: curated lessons plus
    summaries of similar past prints — the app's "learning over time" layer."""
    ctx = print_context
    if lab_context:
        ctx += f"\n\n{lab_context}"
    system = [
        {"type": "text", "text": SYSTEM},
        # The per-print context (metadata + gcode + lab history) is large and
        # stable across turns — cache it so follow-up questions are cheap.
        {"type": "text", "text": ctx, "cache_control": {"type": "ephemeral"}},
    ]

    messages: list[dict] = [
        {"role": m["role"], "content": m["content"]} for m in history
    ]

    content: list[dict] = [_image_block(d, mt) for d, mt in (images or [])]
    content.append({"type": "text", "text": user_message})
    messages.append({"role": "user", "content": content})

    client = get_client(api_key)
    kwargs = dict(
        model=model or DEFAULT_MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=messages,
    )
    try:
        stream_ctx = client.beta.messages.stream(
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            **kwargs,
        )
    except TypeError:
        # Older SDK without the fallbacks parameter — run without it.
        stream_ctx = client.messages.stream(**kwargs)

    with stream_ctx as stream:
        msg = stream.get_final_message()

    if msg.stop_reason == "refusal":
        return (
            "The model declined to answer this request (safety classifier). "
            "Try rephrasing, or ask a lab supervisor to review the prompt."
        )
    return "".join(b.text for b in msg.content if b.type == "text")
