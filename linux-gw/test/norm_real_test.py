import paramiko, base64, time
L = "C:/Users/bropo/Documents/OpenWRT/openwrt-awg-setup/linux-gw/"
REALCONF = "C:/Users/bropo/Documents/OpenWRT/123.conf"
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
for _ in range(50):
    try:
        c.connect("127.0.0.1", port=2222, username="root", password="root", timeout=8, banner_timeout=12, auth_timeout=12); break
    except Exception: time.sleep(5)
def run(cmd, to=120):
    i, o, e = c.exec_command(cmd, timeout=to)
    return (o.read().decode("utf-8", "replace") + e.read().decode("utf-8", "replace")).rstrip()
for _ in range(20):
    if run("docker ps --format '{{.Names}}' 2>&1").count("gw-") >= 3: break
    time.sleep(10)
# deploy new main.py
mp = open(L + "gateway/webui/app/main.py", encoding="utf-8").read()
run("echo " + base64.b64encode(mp.encode()).decode() + " | base64 -d | docker exec -i gw-webui sh -c 'cat > /app/app/main.py'")
run("docker restart gw-webui >/dev/null 2>&1"); time.sleep(8)
# upload real config via panel (file upload endpoint -> normalization)
sftp = c.open_sftp(); sftp.put(REALCONF, "/tmp/123.conf"); sftp.close()
run("curl -sk -c /tmp/cj -X POST -H 'Content-Type: application/json' -d '{\"username\":\"admin\",\"password\":\"admin\"}' https://127.0.0.1/api/login -o /dev/null")
print("upload+normalize: " + run("curl -sk -b /tmp/cj -m 30 -F 'file=@/tmp/123.conf' https://127.0.0.1/api/vpn/config 2>&1 | head -c 220"))
time.sleep(5)
print("\n=== АКТИВНЫЙ конфиг: AllowedIPs нормализован? ===")
print("  " + run("grep -i AllowedIPs /etc/amnezia/awg0.conf"))
print("  orig сохранён, диапазонов: " + run("tr ',' '\\n' < /etc/awg-setup/filter/orig-allowedips.txt | grep -c /"))
print("\n=== туннель к РЕАЛЬНОМУ серверу ===")
print("  handshake/transfer: " + run("docker exec gw-awg awg show awg0 transfer 2>&1 | awk '{print $2,$3}'"))
print("\n=== fwmark-магия включилась (0.0.0.0/0)? ip rule: ===")
print(run("ip -4 rule show 2>&1"))
print("\n=== endpoint петля? (НЕ awg0) ===")
print("  endpoint: " + run("ip route get 212.109.195.138 2>&1 | grep -oE 'dev [^ ]+' | head -1"))
print("  обычный сайт 1.1.1.1: " + run("ip route get 1.1.1.1 2>&1 | grep -oE 'dev [^ ]+' | head -1") + " (должен awg0)")
print("\n=== добавляю 'напрямую' ya.ru — пойдёт мимо туннеля? ===")
run("curl -sk -b /tmp/cj -m 15 -X POST -H 'Content-Type: application/json' -d '{\"action\":\"add\",\"kind\":\"direct\",\"domain\":\"ya.ru\"}' https://127.0.0.1/api/access -o /dev/null"); time.sleep(3)
for ip in run("getent ahostsv4 ya.ru | awk '{print $1}' | sort -u | head -2").split():
    print("  ya.ru " + ip + " -> " + run("ip route get " + ip + " 2>&1 | grep -oE 'dev [^ ]+' | head -1"))
print("\n=== блок example.com ===")
run("curl -sk -b /tmp/cj -m 15 -X POST -H 'Content-Type: application/json' -d '{\"action\":\"add\",\"kind\":\"block\",\"domain\":\"example.com\"}' https://127.0.0.1/api/access -o /dev/null"); time.sleep(3)
print("  A: " + run("docker exec gw-dnsmasq nslookup -type=A example.com 127.0.0.1 2>&1 | grep -i address | tail -1"))
c.close()
