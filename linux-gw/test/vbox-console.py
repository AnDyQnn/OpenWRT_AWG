"""Talk to the gateway VM over a VirtualBox named-pipe serial console.
Logs in as root and runs diagnostic commands, printing their output.
"""
import sys, time

PIPE = r"\\.\pipe\gwpipe"

def open_pipe(timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            f = open(PIPE, "r+b", buffering=0)
            return f
        except OSError:
            time.sleep(1)
    raise SystemExit("could not open pipe " + PIPE)

def main():
    f = open_pipe()
    buf = b""

    def read_for(seconds):
        nonlocal buf
        end = time.time() + seconds
        out = b""
        while time.time() < end:
            try:
                chunk = f.read(4096)
            except Exception:
                chunk = b""
            if chunk:
                out += chunk
                sys.stdout.write(chunk.decode("utf-8", "replace"))
                sys.stdout.flush()
            else:
                time.sleep(0.2)
        buf += out
        return out

    def send(s):
        f.write((s + "\n").encode())
        f.flush()

    # Wake the console
    send("")
    time.sleep(1)
    read_for(3)

    # Login
    send("")
    time.sleep(1)
    data = read_for(3)
    send("root")
    time.sleep(2)
    read_for(2)
    send("openwrt")
    time.sleep(3)
    read_for(3)

    # Diagnostic commands with markers
    cmds = [
        "echo MARK_IMAGES; docker images",
        "echo MARK_PS; docker ps -a --format '{{.Names}} {{.Status}}'",
        "echo MARK_LOAD; docker load -i /opt/gateway/images.tar 2>&1 | tail -8",
        "echo MARK_JOURNAL; journalctl -u gateway-compose -n 20 --no-pager 2>&1 | tail -20",
        "echo MARK_WLOG; tail -15 /var/log/awg-watchdog.log 2>/dev/null",
        "echo MARK_DONE",
    ]
    for c in cmds:
        send(c)
        time.sleep(6)
        read_for(6)

    f.close()

if __name__ == "__main__":
    main()
