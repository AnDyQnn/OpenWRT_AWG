import paramiko, time
c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
for _ in range(20):
    try: c.connect("127.0.0.1",port=2222,username="root",password="root",timeout=8); break
    except Exception: time.sleep(3)
def run(cmd,to=60):
    _,o,e=c.exec_command(cmd,timeout=to)
    return (o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')).encode('ascii','replace').decode('ascii')
print("=== login page ===")
print(run("curl -sk -o /dev/null -w 'GET /login -> %{http_code}\\n' https://127.0.0.1/login"))
print("=== POST /api/login (admin/admin) ===")
print(run(r"""curl -sk -c /tmp/cj -X POST -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}' https://127.0.0.1/api/login -w '\nlogin -> %{http_code}\n'"""))
print("=== авторизованный /api/system ===")
print(run("curl -sk -b /tmp/cj https://127.0.0.1/api/system 2>&1 | head -c 400; echo"))
print("=== авторизованный /api/network ===")
print(run("curl -sk -b /tmp/cj https://127.0.0.1/api/network 2>&1 | head -c 500; echo"))
print("=== static (index/css/js) ===")
print(run("for f in / /static/style.css /static/app.js; do curl -sk -o /dev/null -w \"$f -> %{http_code}\\n\" https://127.0.0.1$f; done"))
print("=== контейнер healthy (рестартов нет) ===")
print(run("docker inspect gw-webui --format 'Restarts={{.RestartCount}} Status={{.State.Status}}' 2>&1"))
c.close()
