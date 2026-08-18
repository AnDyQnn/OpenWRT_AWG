# Тот же подход что в server_conf/rpi-config/docker-router/amneziawg/
FROM golang:alpine AS builder
RUN apk add --no-cache git make build-base linux-headers
RUN git clone https://github.com/amnezia-vpn/amneziawg-go.git /src/awg-go && \
    cd /src/awg-go && make
RUN git clone https://github.com/amnezia-vpn/amneziawg-tools.git /src/awg-tools && \
    cd /src/awg-tools/src && make

FROM alpine:latest
# ipset — наборы IP для пер-хостовых правил доступа (gw-access-apply)
RUN apk add --no-cache bash iptables ip6tables ipset iproute2 openresolv
COPY --from=builder /src/awg-go/amneziawg-go  /usr/bin/amneziawg-go
COPY --from=builder /src/awg-tools/src/wg      /usr/bin/awg
COPY --from=builder /src/awg-tools/src/wg-quick/linux.bash /usr/bin/awg-quick
RUN chmod +x /usr/bin/awg-quick
COPY awg-up.sh /usr/bin/awg-up
COPY gw-access-routes.sh /usr/bin/gw-access-routes
COPY gw-access-apply.sh /usr/bin/gw-access-apply
COPY gw-direct-clients.sh /usr/bin/gw-direct-clients
COPY gw-network-apply.sh /usr/bin/gw-network-apply
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/bin/awg-up /usr/bin/gw-access-routes /usr/bin/gw-access-apply /usr/bin/gw-direct-clients /usr/bin/gw-network-apply
ENTRYPOINT ["/entrypoint.sh"]
