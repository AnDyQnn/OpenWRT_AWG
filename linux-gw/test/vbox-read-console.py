import paramiko, time, sys
def connect():
    for _ in range(15):
        try:
            c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1",port=2222,username="root",password="openwrt",timeout=8,banner_timeout=10,auth_timeout=10)
            return c
        except Exception as e:
            last=e; time.sleep(3)
    print("SSH not available:", last); sys.exit(1)
def run(c,cmd):
    _,o,e=c.exec_command(cmd,timeout=30)
    return (o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace'))
c=connect()
print("=== systemctl gateway-installer ===")
print(run(c,"systemctl is-active gateway-installer; systemctl status gateway-installer --no-pager 2>&1 | head -6"))
print("=== tty1 screen (/dev/vcs1) ===")
print(run(c,"cat /dev/vcs1 2>/dev/null | sed 's/[[:space:]]\\+$//'"))
print("=== jobs (installer should block) ===")
print(run(c,"systemctl list-jobs --no-pager 2>&1 | head"))
c.close()
