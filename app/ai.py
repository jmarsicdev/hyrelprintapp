"""Claude integration for the print-failure chat."""

import base64

from anthropic import Anthropic

MODEL = "claude-opus-5"
MAX_TOKENS = 32000

_client: Anthropic | None = None


def get_client() -> Anthropic:
    """Lazy so the app can start (and the UI can explain what's missing)
    before an API key is configured."""
    global _client
    if _client is None:
        import os
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError(
                "No API key configured. Put ANTHROPIC_API_KEY=sk-ant-... in the "
                ".env file next to the app, then restart it.")
        _client = Anthropic()
    return _client

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

    client = get_client()
    kwargs = dict(
        model=MODEL,
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
