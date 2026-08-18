import paramiko, time
def connect():
    for _ in range(25):
        try:
            c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1",port=2222,username="root",password="openwrt",timeout=8,banner_timeout=10,auth_timeout=10)
            return c
        except Exception: time.sleep(3)
    raise SystemExit("ssh failed")
def run(c,cmd):
    _,o,e=c.exec_command(cmd,timeout=60)
    s=o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')
    return s.encode('ascii','replace').decode('ascii')
c=connect()
for t,cmd in [
 ("docker status", "systemctl status docker --no-pager 2>&1 | head -12"),
 ("docker journal", "journalctl -u docker -n 15 --no-pager 2>&1 | tail -15"),
 ("compose status", "systemctl status gateway-compose --no-pager 2>&1 | head -8"),
 ("gateway-load log", "grep gateway-load /var/log/awg-watchdog.log 2>/dev/null | tail -6"),
]:
    print(f"===== {t} ====="); print(run(c,cmd)); print()
c.close()
