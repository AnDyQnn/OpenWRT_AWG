"""Connect to the gwtest serial pipe, capture the installer prompt, answer it."""
import sys, time

PIPE = r"\\.\pipe\gwpipe"
ANSWER = sys.argv[1] if len(sys.argv) > 1 else "n"   # n=live, y=install

def open_pipe(timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            return open(PIPE, "r+b", buffering=0)
        except OSError:
            time.sleep(1)
    raise SystemExit("pipe not available")

f = open_pipe()
buf = b""
deadline = time.time() + 120
sent = False
print("--- reading serial (waiting for installer prompt) ---")
while time.time() < deadline:
    try:
        chunk = f.read(4096)
    except Exception:
        chunk = b""
    if chunk:
        buf += chunk
        text = chunk.decode("utf-8", "replace")
        sys.stdout.write(text); sys.stdout.flush()
        # When we see the install prompt, send the answer
        if not sent and ("Install to disk?" in buf.decode("utf-8","replace")):
            time.sleep(1)
            if ANSWER == "n":
                f.write(b"n\r\n")
            else:
                f.write(b"\r\n")  # default = install
            f.flush()
            sent = True
            print(f"\n>>> sent answer: '{ANSWER}'\n")
    else:
        time.sleep(0.3)
f.close()
print("\n--- done reading ---")
