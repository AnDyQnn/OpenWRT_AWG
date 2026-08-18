import socket, time, re
s = None
for _ in range(15):
    try: s = socket.create_connection(("127.0.0.1", 5023), timeout=5); break
    except Exception: time.sleep(2)
s.settimeout(2); buf = [""]
def read(t=3):
    end=time.time()+t; out=""
    while time.time()<end:
        try:
            d=s.recv(4096)
            if d: out+=d.decode("utf-8","replace")
            else: time.sleep(0.1)
        except socket.timeout: pass
        except Exception: break
    buf[0]+=out; return out
def send(x): s.sendall((x+"\n").encode()); time.sleep(0.3)
send(""); read(1)
for _ in range(10):
    o=read(1)
    if ":~#" in o or "login:" in o:
        if "login:" in o: send("root"); time.sleep(1); read(1)
        break
    send("")
send("nslookup ya.ru 2>&1 | grep -i address"); read(6)
send("wget -T12 -qO- https://ya.ru 2>&1 | grep -o 'lang=\"ru\"' | head -1"); read(14)
read(2); s.close()
clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", buf[0])
for line in clean.splitlines():
    l=line.strip()
    if l and not l.startswith(("nslookup","wget","localhost:~#")) and any(k in l for k in("Address","lang=","0.0.0.0","::","bad")):
        print("  | "+l[:80])
