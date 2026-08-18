import paramiko, time
c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
for _ in range(20):
    try:
        c.connect("127.0.0.1",port=2222,username="root",password="root",timeout=8); break
    except Exception: time.sleep(3)
def run(cmd,to=60):
    _,o,e=c.exec_command(cmd,timeout=to)
    return (o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')).encode('ascii','replace').decode('ascii')
print("=== ХОСТ для сравнения ===")
print(run("echo -n 'RAM total (МБ): '; awk '/MemTotal/{print int($2/1024)}' /proc/meminfo; echo -n 'интерфейсы: '; ls /sys/class/net | tr '\\n' ' '; echo"))
print("=== psutil ВНУТРИ gw-webui (без /proc монтирования) ===")
py="import psutil,os; vm=psutil.virtual_memory(); print('RAM total (МБ):',int(vm.total/1024/1024)); print('CPU%:',psutil.cpu_percent(interval=0.3)); print('loadavg:',os.getloadavg()); print('интерфейсы:',list(psutil.net_if_addrs().keys()))"
print(run(f"docker exec gw-webui python -c \"{py}\" 2>&1"))
print("=== авторизованный /api/system ===")
login=run("curl -sk -c /tmp/cj -d 'username=admin&password=admin' https://127.0.0.1/login -o /dev/null -w '%{http_code}'; echo")
print("login http:",login.strip())
print(run("curl -sk -b /tmp/cj https://127.0.0.1/api/system 2>&1 | head -c 400; echo"))
print(run("curl -sk -b /tmp/cj https://127.0.0.1/api/network 2>&1 | head -c 500; echo"))
c.close()
