"""Verify production features on the VM: growroot (disk size) + swap."""
import paramiko, time

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
    return (out.read().decode("utf-8","replace") + err.read().decode("utf-8","replace")).strip()

c = connect()
for title, cmd in [
    ("containers", "docker ps --format '{{.Names}} {{.Status}}'"),
    ("disk (growroot -> ~20G)", "df -h / | tail -1"),
    ("swap (gateway-swap)", "free -h | grep -i swap"),
    ("swapon", "swapon --show 2>/dev/null"),
    ("dhcp range", "docker exec gw-dnsmasq grep dhcp-range /etc/dnsmasq.conf 2>/dev/null"),
]:
    print(f"== {title} ==")
    print(run(c, cmd))
    print()
c.close()
