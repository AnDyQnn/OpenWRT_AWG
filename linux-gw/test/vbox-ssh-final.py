"""Final SSH check on the gateway VM: containers + status."""
import paramiko, time, sys

def connect():
    for _ in range(20):
        try:
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1", port=2222, username="root", password="openwrt",
                      timeout=8, banner_timeout=10, auth_timeout=10)
            return c
        except Exception:
            time.sleep(3)
    raise SystemExit("ssh failed")

def run(c, cmd):
    _, out, err = c.exec_command(cmd, timeout=40)
    return out.read().decode("utf-8","replace") + err.read().decode("utf-8","replace")

c = connect()
for title, cmd in [
    ("docker ps", "docker ps --format '{{.Names}}  {{.Status}}'"),
    ("gateway-load log", "grep gateway-load /var/log/awg-watchdog.log | tail -5"),
    ("growroot log", "grep growroot /var/log/awg-watchdog.log | tail -3"),
    ("disk free", "df -h / | tail -1"),
    ("awg mode", "cat /run/awg-mode 2>/dev/null; echo"),
]:
    print(f"===== {title} =====")
    print(run(c, cmd).strip())
    print()
c.close()
