"""One tiny real API call to verify the key, model, and fallback param work.
Run manually: python live_test.py  (costs a few cents)"""

from app import ai

reply = ai.chat(
    print_context="Print record: test print, Hyrel SDS head, 0.5mm nozzle. "
                  "G-code: G1 X10 E5 F900 (single line test).",
    history=[],
    user_message="Reply with exactly: OK <model check>",
)
print("MODEL:", ai.MODEL)
print("REPLY:", reply[:200])
