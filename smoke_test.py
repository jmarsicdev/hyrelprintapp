"""Offline smoke test: exercises print creation, outcome tagging, and the
past-case retrieval layer without calling the Claude API. Run:
    python smoke_test.py
"""

import os

os.environ.setdefault("ANTHROPIC_API_KEY", "test-not-real")
os.environ.setdefault("DATA_DIR", "./data-smoketest")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app, build_lab_context  # noqa: E402

GCODE = (
    "G21\nM722 S100 E21000 P500 T11\n"
    "M221 S1.0 T11 P1760 W0.5 Z0.3\n"
    "G1 X10 F1200\nG1 Z0.3\nG1 Z0.6\n"
)


def main() -> None:
    c = TestClient(app)

    r = c.post("/api/prints", files={"gcode_file": ("a.gcode", GCODE)},
               data={"printer_id": 1, "operator": "smoke"})
    assert r.status_code == 200, r.text
    p1 = r.json()["id"]
    assert r.json()["params"]["flow_settings_m221"][0]["P"] == 1760.0

    r = c.post(f"/api/prints/{p1}/outcome",
               data={"outcome": "tuning", "outcome_notes": "over-extruded corners",
                     "tags": "over-extrusion"})
    assert r.status_code == 200, r.text

    r = c.post("/api/prints", files={"gcode_file": ("b.gcode", GCODE)},
               data={"printer_id": 1})
    p2 = r.json()["id"]

    ctx = build_lab_context(p2, "over-extrusion")
    assert p1 in ctx and "over-extruded corners" in ctx, ctx

    # Custom fields: free-form dataset columns without code changes.
    r = c.post(f"/api/prints/{p2}/fields",
               data={"fields_json": '{"drying time": "24 h", "humidity %": "41"}'})
    assert r.status_code == 200, r.text
    r = c.get(f"/api/prints/{p2}")
    assert r.json()["custom"]["drying time"] == "24 h", r.json()

    # Photo with a source label (camera capture provenance).
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (100, 80), (200, 120, 90)).save(buf, "JPEG")
    r = c.post(f"/api/prints/{p2}/photos",
               files={"file": ("capture.jpg", buf.getvalue(), "image/jpeg")},
               data={"source": "capture:USB Microscope", "caption": "layer 2 corner"})
    assert r.status_code == 200, r.text
    r = c.get(f"/api/prints/{p2}")
    assert r.json()["photos"][0]["source"] == "capture:USB Microscope"

    print("smoke test OK — retrieval, custom fields, and photo provenance all work:")
    print(ctx[:300])


if __name__ == "__main__":
    main()
