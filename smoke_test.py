"""Offline smoke test: exercises print creation, outcome tagging, and the
past-case retrieval layer without calling the Claude API. Run:
    python smoke_test.py
"""

import os
import pathlib
import shutil

os.environ.setdefault("ANTHROPIC_API_KEY", "test-not-real")
os.environ.setdefault("DATA_DIR", "./data-smoketest")
os.environ.setdefault("GCODE_DIR", "./gcode-smoketest")

# Start from a clean slate: the test writes settings (it switches the model to
# Sonnet), so re-running against a leftover database would fail on assertions
# that expect the defaults. Only ever removes this test's own scratch dirs.
for _scratch in (os.environ["DATA_DIR"], os.environ["GCODE_DIR"]):
    if _scratch.startswith("./") and "smoketest" in _scratch:
        shutil.rmtree(_scratch, ignore_errors=True)
pathlib.Path("./gcode-smoketest/jobs").mkdir(parents=True, exist_ok=True)

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

    # Model picker + key settings endpoints (no network).
    r = c.get("/api/models")
    assert r.json()["current"] == "claude-opus-5", r.json()
    assert any(m["id"] == "claude-sonnet-5" for m in r.json()["models"])
    r = c.post("/api/models", data={"model": "claude-sonnet-5"})
    assert r.status_code == 200
    assert c.get("/api/models").json()["current"] == "claude-sonnet-5"
    assert c.post("/api/models", data={"model": "gpt-9"}).status_code == 400
    r = c.get("/api/settings")
    assert r.json()["key_source"] in ("env", "none"), r.json()

    # Repetrel-folder round trip: pick a file from GCODE_DIR, save a
    # revision, and confirm it lands next to the original (original intact).
    src = pathlib.Path("./gcode-smoketest/jobs/cup.gcode")
    src.write_text(GCODE)
    r = c.get("/api/gcode-files")
    assert r.json()["available"] and any(
        f["path"].endswith("cup.gcode") for f in r.json()["files"]), r.json()
    r = c.post("/api/prints", data={"printer_id": 1,
                                    "source_path": "jobs/cup.gcode"})
    assert r.status_code == 200, r.text
    p3 = r.json()["id"]
    r = c.post(f"/api/prints/{p3}/revisions", data={"content": "G21\nG1 X5\n"})
    assert r.status_code == 200, r.text
    rev = r.json()["repetrel_path"]
    assert rev and rev.endswith("cup_rev01.gcode"), r.json()
    assert pathlib.Path(rev).read_text() == "G21\nG1 X5\n"
    assert src.read_text() == GCODE  # original untouched
    # Path traversal must be rejected.
    r = c.post("/api/prints", data={"printer_id": 1, "source_path": "../smoke_test.py"})
    assert r.status_code == 400, r.text

    # API failures must reach the chat window as readable text, not a bare 500.
    # The SDK raises AuthenticationError/APIConnectionError, which are not
    # RuntimeError — before app.ai.explain() existed these escaped as a 500.
    import httpx
    import anthropic
    from app import ai
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    bad_key = anthropic.AuthenticationError(
        "bad key", response=httpx.Response(401, request=req), body=None)
    for err, expected in ((bad_key, "sk-ant-"),
                          (anthropic.APIConnectionError(request=req), "network problem")):
        translated = ai.explain(err)
        assert isinstance(translated, RuntimeError), translated
        assert expected in str(translated), translated

    def _refuse_key(*args, **kwargs):
        raise ai.explain(bad_key)

    original, ai.chat = ai.chat, _refuse_key
    try:
        r = c.post(f"/api/prints/{p1}/chat", data={"message": "why did it slump?"})
    finally:
        ai.chat = original
    assert r.status_code == 503, r.status_code
    assert "sk-ant-" in r.json()["detail"], r.text

    print("smoke test OK — retrieval, custom fields, photo provenance, "
          "model picker, settings, Repetrel-folder round trip, and readable "
          "API-error handling all work:")
    print(ctx[:300])


if __name__ == "__main__":
    main()
