import paramiko, time, sys
def connect():
    for _ in range(20):
        try:
            c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1",port=2222,username="root",password="openwrt",timeout=8,banner_timeout=10,auth_timeout=10)
            return c
        except Exception: time.sleep(3)
    raise SystemExit("ssh failed")
def run(c,cmd):
    _,o,e=c.exec_command(cmd,timeout=40)
    s=o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')
    return s.encode('ascii','replace').decode('ascii').strip()
c=connect()
for t,cmd in [
    ("growroot active?", "systemctl is-active gateway-growroot; systemctl is-enabled gateway-growroot"),
    ("growroot journal", "journalctl -u gateway-growroot --no-pager 2>&1 | tail -12"),
    ("swap active?", "systemctl is-active gateway-swap; systemctl is-enabled gateway-swap"),
    ("swap journal", "journalctl -u gateway-swap --no-pager 2>&1 | tail -12"),
    ("manual growpart test", "growpart /dev/sda 3 2>&1; echo '---'; df -h / | tail -1"),
]:
    print(f"== {t} =="); print(run(c,cmd)); print()
c.close()
