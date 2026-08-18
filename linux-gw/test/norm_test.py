# Автономный тест логики _normalize_config (копия регулярок из main.py)
import re

def normalize(text):
    NEW = "AllowedIPs = 0.0.0.0/0, ::/0"
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    allowed_re = re.compile(r"(?im)^[ \t]*AllowedIPs[ \t]*=[ \t]*(.*?)[ \t]*$")
    orig = ""
    for v in allowed_re.findall(text):
        if v.strip():
            orig = v.strip(); break
    if allowed_re.search(text):
        state = {"done": False}
        def _repl(_m):
            if state["done"]:
                return "__DROP_ALLOWEDIPS__"
            state["done"] = True
            return NEW
        text = allowed_re.sub(_repl, text)
        text = re.sub(r"(?m)^__DROP_ALLOWEDIPS__\n?", "", text)
    elif re.search(r"(?im)^[ \t]*\[Peer\]", text):
        text = re.sub(r"(?im)^([ \t]*\[Peer\][ \t]*)$", r"\1\n" + NEW, text, count=1)
    else:
        text = text.rstrip() + "\n\n[Peer]\n" + NEW + "\n"
    return text, orig

cases = {
 "1.антифильтр": "[Interface]\nPrivateKey = K\nAddress = 10.13.13.16/32\n\n[Peer]\nPublicKey = P\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/2, 64.0.0.0/3, 212.0.0.0/8, ::/0\n",
 "2.пустой AllowedIPs": "[Interface]\nPrivateKey = K\n\n[Peer]\nEndpoint = 1.2.3.4:51820\nAllowedIPs = \n",
 "3.нет AllowedIPs": "[Interface]\nPrivateKey = K\n\n[Peer]\nPublicKey = P\nEndpoint = 1.2.3.4:51820\n",
 "4.CRLF+дубль": "[Interface]\r\nPrivateKey = K\r\n\r\n[Peer]\r\nAllowedIPs = 1.2.3.0/24\r\nAllowedIPs = 5.6.7.0/24\r\nEndpoint = 1.2.3.4:51820\r\n",
 "5.стоковый 0/0": "[Interface]\nPrivateKey = K\n\n[Peer]\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0, ::/0\n",
}
for name, cfg in cases.items():
    out, orig = normalize(cfg)
    n_allowed = len(re.findall(r"(?im)^AllowedIPs", out))
    has_new = "AllowedIPs = 0.0.0.0/0, ::/0" in out
    has_peer = "[Peer]" in out
    ok = (n_allowed == 1) and has_new and has_peer
    print(f"{name}: AllowedIPs строк={n_allowed} новая={has_new} [Peer]={has_peer} orig='{orig[:30]}' -> {'OK' if ok else 'ПРОВАЛ'}")
