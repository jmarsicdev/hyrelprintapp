"""G-code analysis tuned for Hyrel/Repetrel paste extrusion.

Repetrel embeds Slic3r/PrusaSlicer for the file body and adds Hyrel-specific
M-codes (documented at hyrel3d.com/wiki; also see C:\\Repetrel\\data\\
"G-Code dictionary.csv" on the printer PC). Flow is volumetric and pulse-based:
dispense rate = width x height x speed x pulses/uL x multiplier, so the M221 /
M721 / M722 parameters are the ones that matter most for paste prints.

Caveat recorded here because it shapes the dataset: Repetrel sends the head
dialog settings (prime/unprime/flow values set in the UI) to the printer
*before* streaming the file, so the .gcode on disk is necessary but not always
sufficient to reproduce a print. Students should note UI-set head values in
the print record.
"""

import re
from collections import Counter

HYREL_MCODES = {
    "M721": "unprime (retract) settings: S rate, E pulses, P pause, T tool",
    "M722": "prime (advance) settings: S rate, E pulses, P pause, T tool",
    "M221": "flow: S multiplier, T tool, P pulses/uL, W path width, Z layer height",
    "M229": "extrusion mode: E0 D0 = native volumetric, E1 D1 = use slicer E values",
    "M756": "override Z layer thickness used in flow calc",
    "M723": "manual flow control",
    "M772": "reset metrics / enable reporting (header)",
    "M627": "abort behavior config (header)",
    "M703": "head cloning",
    "M660": "tool height offset",
    "M6": "per-head X/Y/Z offsets on tool change",
}

_CMD_RE = re.compile(r"^([GMT]\d+(?:\.\d+)?)", re.IGNORECASE)
_F_RE = re.compile(r"\bF(\d+(?:\.\d+)?)")
_Z_RE = re.compile(r"\bZ(-?\d+(?:\.\d+)?)")
_PARAM_RE = re.compile(r"\b([A-Z])(-?\d+(?:\.\d+)?)")


def _params(line: str) -> dict[str, float]:
    return {k: float(v) for k, v in _PARAM_RE.findall(line)}


def analyze(text: str) -> dict:
    lines = text.splitlines()

    header: list[str] = []
    for line in lines[:200]:
        s = line.strip()
        if s.startswith(";"):
            header.append(s)
        elif s:
            break

    cmd_counts: Counter[str] = Counter()
    feeds: list[float] = []
    z_values: list[float] = []
    tools: set[str] = set()
    flow_settings: list[dict] = []      # M221 occurrences
    prime_settings: list[dict] = []     # M722
    unprime_settings: list[dict] = []   # M721

    for line in lines:
        s = line.split(";", 1)[0].strip()
        if not s:
            continue
        m = _CMD_RE.match(s)
        if not m:
            continue
        cmd = m.group(1).upper()
        cmd_counts[cmd] += 1
        if cmd.startswith("T"):
            tools.add(cmd)
        elif cmd in ("G0", "G1", "G2", "G3"):
            fm = _F_RE.search(s)
            if fm:
                feeds.append(float(fm.group(1)))
            zm = _Z_RE.search(s)
            if zm:
                z_values.append(float(zm.group(1)))
        elif cmd == "M221" and len(flow_settings) < 10:
            flow_settings.append(_params(s[4:]))
        elif cmd == "M722" and len(prime_settings) < 10:
            prime_settings.append(_params(s[4:]))
        elif cmd == "M721" and len(unprime_settings) < 10:
            unprime_settings.append(_params(s[4:]))

    unique_z = sorted(set(z_values))
    layer_height = None
    if len(unique_z) >= 3:
        diffs = [round(b - a, 4) for a, b in zip(unique_z, unique_z[1:]) if b - a > 0.001]
        if diffs:
            layer_height = Counter(diffs).most_common(1)[0][0]

    hyrel_seen = {c: cmd_counts[c] for c in HYREL_MCODES if cmd_counts.get(c)}

    # Paste-job signature: reservoir/syringe heads (SDS/EMO) use much larger
    # prime/unprime pulse counts and long dwells, and print cold (no M109).
    big_prime = any(p.get("E", 0) > 5000 or p.get("P", 0) > 100 for p in prime_settings)
    no_head_temp = cmd_counts.get("M109", 0) == 0
    likely_paste = bool(prime_settings) and (big_prime or no_head_temp)

    return {
        "total_lines": len(lines),
        "header_comments": header[:40],
        "command_counts": dict(cmd_counts.most_common(25)),
        "tools_used": sorted(tools),
        "feed_rate_min": min(feeds) if feeds else None,
        "feed_rate_max": max(feeds) if feeds else None,
        "z_min": unique_z[0] if unique_z else None,
        "z_max": unique_z[-1] if unique_z else None,
        "estimated_layer_height": layer_height,
        "estimated_layer_count": len(unique_z) or None,
        "hyrel_mcodes": hyrel_seen,
        "flow_settings_m221": flow_settings,
        "prime_m722": prime_settings,
        "unprime_m721": unprime_settings,
        "likely_paste_job": likely_paste,
    }


# Keep the full file in the AI context when it comfortably fits; otherwise
# send the head plus the parsed summary so the model still sees real code.
FULL_FILE_CHAR_LIMIT = 400_000


def context_snippet(text: str, summary: dict) -> str:
    if len(text) <= FULL_FILE_CHAR_LIMIT:
        return f"Full G-code file:\n```gcode\n{text}\n```"
    head = "\n".join(text.splitlines()[:400])
    return (
        f"The G-code file is large ({len(text)} chars); showing the first 400 lines. "
        f"Parsed summary: {summary}\n```gcode\n{head}\n```"
    )
