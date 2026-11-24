#!/usr/bin/env bash
# Starts two agnhost listeners on the kind Docker network, outside the cluster:
# the canary (an excepted egress address, like a metadata server) and an open
# listener (an ordinary outside address no policy cuts). Prints
# CANARY=<ip> and OPEN=<ip> for eval. `stop` removes both.
#
#   eval "$(scripts/kind-isolation/listeners.sh start)"
set -euo pipefail
AGNHOST=${AGNHOST:-'registry.k8s.io/e2e-test-images/agnhost:2.59@sha256:10ed98804c877e505e17bced991682b6fd50ab1da9cddcd19935b48d645da40a'}
case ${1:-} in
  start)
    subnet=$(docker network inspect kind -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -1)
    ip() { python3 -c "import ipaddress,sys; print(ipaddress.ip_network(sys.argv[1]).network_address + int(sys.argv[2]))" "$subnet" "$1"; }
    canary=$(ip 250)
    open=$(ip 251)
    docker run -d --name isolation-canary --network kind --ip "$canary" "$AGNHOST" netexec --http-port=8080 >/dev/null
    docker run -d --name isolation-open --network kind --ip "$open" "$AGNHOST" netexec --http-port=8080 >/dev/null
    echo "CANARY=$canary"
    echo "OPEN=$open"
    ;;
  stop)
    docker rm -fv isolation-canary isolation-open >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
