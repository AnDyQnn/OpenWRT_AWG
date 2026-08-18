"""SSH into the gateway VM (via NAT port-forward 2222) and run diagnostics."""
import paramiko, sys, time

HOST, PORT, USER, PWD = "127.0.0.1", 2222, "root", "openwrt"

def connect(timeout=120):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect(HOST, port=PORT, username=USER, password=PWD,
                      timeout=8, banner_timeout=8, auth_timeout=8)
            return c
        except Exception as e:
            last = e
            time.sleep(4)
    raise SystemExit(f"SSH connect failed: {last}")

def run(c, cmd):
    stdin, stdout, stderr = c.exec_command(cmd, timeout=60)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return out + (("\n[stderr] " + err) if err.strip() else "")

def main():
    print("Connecting via SSH 127.0.0.1:2222 ...")
    c = connect()
    print("Connected.\n")
    cmds = [
        ("docker images", "docker images"),
        ("docker ps -a", "docker ps -a --format '{{.Names}}\\t{{.Status}}'"),
        ("compose ps", "cd /opt/gateway && docker compose ps -a 2>&1 | tail -10"),
        ("gateway-compose journal", "journalctl -u gateway-compose -n 25 --no-pager 2>&1 | tail -25"),
        ("watchdog log", "tail -20 /var/log/awg-watchdog.log 2>/dev/null"),
        ("manual docker load", "docker load -i /opt/gateway/images.tar 2>&1 | tail -10"),
        ("docker info store", "docker info 2>/dev/null | grep -iE 'storage|driver|snapshotter'"),
    ]
    for title, cmd in cmds:
        print(f"===== {title} =====")
        print(run(c, cmd))
        print()
    c.close()

if __name__ == "__main__":
    main()
