"""Run this ON THE HYREL PC before anything else: verifies the lab network
allows outbound HTTPS to the Claude API. No API key needed.

    py check_network.py
"""

import json
import socket
import ssl
import sys
import urllib.request

HOSTNAME = "api.anthropic.com"


def main() -> int:
    print(f"1) DNS lookup for {HOSTNAME} ...", end=" ")
    try:
        ip = socket.gethostbyname(HOSTNAME)
        print(f"OK ({ip})")
    except OSError as e:
        print(f"FAILED ({e})\n   -> DNS is blocked or no internet. Talk to IT.")
        return 1

    print("2) TLS connection on port 443 ...", end=" ")
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((HOSTNAME, 443), timeout=10) as sock:
            with ctx.wrap_socket(sock, server_hostname=HOSTNAME):
                print("OK")
    except OSError as e:
        print(f"FAILED ({e})\n   -> Port 443 to this host is blocked (firewall/proxy). Talk to IT.")
        return 1

    print("3) API endpoint responds ...", end=" ")
    req = urllib.request.Request(
        f"https://{HOSTNAME}/v1/messages",
        data=b"{}",
        headers={"content-type": "application/json", "anthropic-version": "2023-06-01"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=15)
        print("OK (unexpected success)")
    except urllib.error.HTTPError as e:
        # 401 (no key) or 400 means we reached Anthropic's servers - success.
        body = e.read().decode(errors="replace")[:200]
        try:
            err_type = json.loads(body).get("error", {}).get("type", "?")
        except json.JSONDecodeError:
            err_type = "?"
        if e.code in (400, 401):
            print(f"OK (HTTP {e.code} {err_type} - expected without an API key)")
        else:
            print(f"WARNING: HTTP {e.code} {err_type} - possibly a proxy intercepting.")
    except OSError as e:
        print(f"FAILED ({e})")
        return 1

    print("\nNetwork looks good. Next: put your API key in .env and run run.bat")
    return 0


if __name__ == "__main__":
    sys.exit(main())
