import socket, time, sys
HOST,PORT=("127.0.0.1",5023)
def conn():
    for _ in range(20):
        try:
            s=socket.create_connection((HOST,PORT),timeout=5); s.settimeout(2); return s
        except Exception: time.sleep(2)
    raise SystemExit("no serial")
s=conn()
buf=""
def read(t=3):
    global buf
    end=time.time()+t; out=""
    while time.time()<end:
        try:
            d=s.recv(4096)
            if d: out+=d.decode('utf-8','replace');
            else: time.sleep(0.1)
        except socket.timeout: pass
        except Exception: break
    buf+=out; return out
def send(cmd):
    s.sendall((cmd+"\n").encode()); time.sleep(0.3)

# разбудить консоль
send(""); read(2)
# дождаться login и залогиниться
for _ in range(30):
    o=read(2)
    if "login:" in (o+buf)[-200:] or "login:" in o:
        send("root"); time.sleep(1); read(2); break
    if o.strip().endswith("#") or ":~#" in o: break
    send("")
time.sleep(1); read(1)
# тесты (echo-маркеры, чтобы вычленить вывод)
cmds=[
 "echo MARK_START",
 "ip link set eth0 up",
 "udhcpc -i eth0 -n -q 2>&1 | tail -3",
 "echo '== addr =='; ip -4 addr show eth0 | grep inet",
 "echo '== route =='; ip route | grep default",
 "echo '== ping gw =='; ping -c2 -W2 192.168.88.1 | tail -2",
 "echo '== ping inet =='; ping -c2 -W2 1.1.1.1 | tail -2",
 "echo '== dns =='; nslookup google.com 2>&1 | tail -3",
 "echo '== panel http =='; wget -S -O /dev/null http://192.168.88.1/ 2>&1 | grep -iE 'HTTP/|location' | head -3",
 "echo MARK_END",
]
for cmd in cmds:
    send(cmd); read(4 if "ping" in cmd or "wget" in cmd or "dhcp" in cmd.lower() or "udhcpc" in cmd else 2)
read(3)
s.close()
# печать от MARK_START
out=buf
i=out.find("MARK_START")
print(out[i:] if i>=0 else out[-3000:])
