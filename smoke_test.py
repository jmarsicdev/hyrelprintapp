"""Offline smoke test: exercises print creation, outcome tagging, and the
past-case retrieval layer without calling the Claude API. Run:
    python smoke_test.py
"""

import json
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
    assert pathlib.Path(rev).read_text(encoding="utf-8") == "G21\nG1 X5\n"
    assert src.read_text(encoding="utf-8") == GCODE  # original untouched
    # Path traversal must be rejected.
    r = c.post("/api/prints", data={"printer_id": 1, "source_path": "../smoke_test.py"})
    assert r.status_code == 400, r.text

    # Client-supplied names are untrusted: any page in any browser tab on this
    # PC can POST here, so an upload name must not escape the print folder and
    # a photo name must not read files outside it.
    r = c.post("/api/prints", files={"gcode_file": ("../../escaped.gcode", GCODE)},
               data={"printer_id": 1})
    assert r.status_code == 200, r.text
    assert r.json()["gcode_filename"] == "escaped.gcode", r.json()
    escaped = r.json()["id"]
    assert (pathlib.Path(os.environ["DATA_DIR"]) / "prints" / escaped
            / "escaped.gcode").is_file()
    secret = pathlib.Path(os.environ["DATA_DIR"]).resolve() / "SECRET.txt"
    secret.write_text("lab secret", encoding="utf-8")
    assert c.get(f"/api/prints/{escaped}/photos/{secret}").status_code == 404
    assert c.get(f"/api/prints/{escaped}/photos/..%5C..%5CSECRET.txt").status_code == 404

    # ---- the tuning loop: refine a print, then print the refinement ----

    # Model output routinely contains µ, Ø, →, ≈; the Windows default encoding
    # (cp1252) cannot encode several of those, which used to 500 on save.
    UNICODE_GCODE = "G21 ; flow ≈ W×H×speed, nozzle Ø0.5, 1760 pulses/µL\nM221 S1.1 T11\n"
    r = c.post(f"/api/prints/{p3}/revisions", data={"content": UNICODE_GCODE})
    assert r.status_code == 200, r.text
    rev2 = pathlib.Path(r.json()["repetrel_path"])
    assert rev2.name == "cup_rev02.gcode", rev2
    assert rev2.read_text(encoding="utf-8") == UNICODE_GCODE

    # A second record made from the same original must not clobber the first
    # student's revision files.
    p4 = c.post("/api/prints", data={"printer_id": 1,
                                     "source_path": "jobs/cup.gcode"}).json()["id"]
    r = c.post(f"/api/prints/{p4}/revisions", data={"content": "G21\nG1 X9\n"})
    other = pathlib.Path(r.json()["repetrel_path"])
    assert other.name == "cup_rev03.gcode", other       # not rev01 again
    assert pathlib.Path(rev).read_text(encoding="utf-8") == "G21\nG1 X5\n"  # intact
    assert rev2.read_text(encoding="utf-8") == UNICODE_GCODE               # intact

    # Close the loop: the revision is itself printable, so it becomes the
    # source of the next print record, and can be refined again.
    p5 = c.post("/api/prints", data={"printer_id": 1,
                                     "source_path": "jobs/cup_rev02.gcode"}).json()["id"]
    detail = c.get(f"/api/prints/{p5}").json()
    assert detail["params"]["flow_settings_m221"][0]["S"] == 1.1, detail["params"]
    r = c.post(f"/api/prints/{p5}/revisions", data={"content": "G21\nM221 S1.2 T11\n"})
    assert pathlib.Path(r.json()["repetrel_path"]).name == "cup_rev02_rev01.gcode", r.json()

    # meta.json stays valid, UTF-8, and carries the parsed parameters.
    meta = json.loads((pathlib.Path(os.environ["DATA_DIR"]) / "prints" / p5 / "meta.json")
                      .read_text(encoding="utf-8"))
    assert meta["id"] == p5 and meta["params"]["flow_settings_m221"][0]["S"] == 1.1, meta

    # New intake fields survive the round trip, and every record field is
    # editable afterwards — they used to be settable only at creation, so a
    # typo was permanent and silently skewed past-case retrieval.
    r = c.post("/api/prints", files={"gcode_file": ("params.gcode", GCODE)},
               data={"printer_id": 1, "operator": "ana", "spiral_spacing_mm": "1.25",
                     "print_speed": "12 mm/s", "pressure_setting": "45 psi",
                     "solids_loading_pct": "62"})
    assert r.status_code == 200, r.text
    pf = r.json()
    assert pf["spiral_spacing_mm"] == 1.25 and pf["print_speed"] == "12 mm/s", pf
    assert pf["pressure_setting"] == "45 psi", pf

    r = c.post(f"/api/prints/{pf['id']}/record",
               data={"solids_loading_pct": "58.5", "print_speed": "9 mm/s",
                     "notes": "corrected after weighing the batch"})
    assert r.status_code == 200, r.text
    upd = r.json()
    assert upd["solids_loading_pct"] == 58.5 and upd["print_speed"] == "9 mm/s", upd
    assert upd["notes"] == "corrected after weighing the batch", upd
    # Fields that were not sent must be left alone.
    assert upd["operator"] == "ana" and upd["pressure_setting"] == "45 psi", upd
    # Blanking a number clears it rather than crashing; junk is rejected.
    assert c.post(f"/api/prints/{pf['id']}/record",
                  data={"nozzle_diameter_mm": ""}).json()["nozzle_diameter_mm"] is None
    assert c.post(f"/api/prints/{pf['id']}/record",
                  data={"solids_loading_pct": "abc"}).status_code == 400
    assert c.post(f"/api/prints/{pf['id']}/record", data={}).status_code == 400
    # inf/nan must never reach the database: JSON cannot represent them, so a
    # single committed row would 500 every later read of the prints list.
    for bad in ("inf", "-inf", "Infinity", "1e400", "nan"):
        r = c.post(f"/api/prints/{pf['id']}/record", data={"solids_loading_pct": bad})
        assert r.status_code == 400, f"{bad!r} was accepted: {r.text}"
        assert c.get("/api/prints").status_code == 200, f"prints list broken after {bad!r}"
    r = c.post("/api/prints", files={"gcode_file": ("inf.gcode", GCODE)},
               data={"printer_id": 1, "nozzle_diameter_mm": "1e400"})
    assert r.status_code == 400, r.text
    assert c.get("/api/prints").status_code == 200
    meta_pf = json.loads((pathlib.Path(os.environ["DATA_DIR"]) / "prints" / pf["id"]
                          / "meta.json").read_text(encoding="utf-8"))
    assert meta_pf["print_speed"] == "9 mm/s", meta_pf

    # Lab notes are the shared memory across prints: stored as data/LESSONS.md
    # and pulled into every chat by build_lab_context.
    assert c.get("/api/lab-notes").json()["text"] == ""
    LESSON = "Below 60% solids the slurry slumps on walls ≥ 30 mm.\n"
    assert c.post("/api/lab-notes", data={"text": LESSON}).status_code == 200
    assert c.get("/api/lab-notes").json()["text"] == LESSON
    assert LESSON.strip() in build_lab_context(p1, "")

    # The build stamp is what tells a stale browser cache from a stale exe.
    assert c.get("/api/version").json()["build"], "build id must not be empty"

    # The phone-upload path is gone on purpose: it was the only reason to bind
    # to the LAN, and nothing here is authenticated. Keep it gone.
    assert c.get(f"/api/prints/{p1}/qr").status_code == 404
    assert c.get(f"/p/{p1}/upload").status_code == 404
    from app import config as _config
    assert not _config.HOST.startswith("0.0.0.0"), _config.HOST

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
