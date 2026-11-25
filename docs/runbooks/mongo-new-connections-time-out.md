# New MongoDB connections time out while the backend keeps working

**Symptom.** One-off scripts, backups and any freshly started client fail with
`Server selection timed out`, while the serving backend logs no Mongo errors and
its database routes answer normally. A raw TCP connect from a new container
reaches some replica-set members and times out on one, usually the primary.

That split is the signature. A member in maintenance or failover would also break
the connections the backend already holds, and the driver would log it. When
established connections keep working and only **new** ones to **one** address
fail, suspect the outbound NAT, not the database.

## Why it happens

A VM without an external IP reaches the internet through Cloud NAT. Cloud NAT
gives each VM a fixed number of source ports **per destination IP and port**,
and the default `minPortsPerVm` is **64**. Every connection the VM holds to a
given Mongo member uses one of those ports.

The driver opens most of its pool against the primary. One backend process
with a busy pool can hold 64 connections to the primary alone. The next new
connection to that address then has no source port, and Cloud NAT drops its SYN
without a reply. The connections that already exist are untouched, so the
backend keeps serving until it restarts or needs to grow its pool. After a
restart, it cannot reach the primary at all.

So this fails quietly first and loudly later. Rolling or restarting the backend
while it is in this state can take the database away from production.

## Check

On the VM, count established connections per Mongo member. Container traffic
lives in each container's network namespace, so `ss` on the host shows none of
it. Read the container's namespace, or conntrack for all containers together:

```bash
# one container (read-only; nothing runs inside the container)
P=$(docker inspect -f '{{.State.Pid}}' <backend-container>)
nsenter -t "$P" -n ss -tnH state established '( dport = :27017 )' \
  | awk '{print $4}' | sed 's/:27017$//' | sort | uniq -c

# every container on the host (the conntrack tool may be absent; the proc file is not)
grep 'dport=27017 ' /proc/net/nf_conntrack | grep ESTABLISHED \
  | grep -o 'dst=[0-9.]*' | awk 'NR%2==1' | sort | uniq -c
```

If one member sits at or near the NAT's per-VM port count while the others hold
a handful, this is the cause.

Then confirm the NAT's settings:

```bash
gcloud compute routers nats describe <nat> --router=<router> --region=<region> \
  --format='value(minPortsPerVm,enableDynamicPortAllocation,logConfig.enable)'
```

An empty `minPortsPerVm` means the default of 64.

## Fix

Raise the per-VM port allocation. Nothing restarts, and the change takes effect
in seconds:

```bash
gcloud compute routers nats update <nat> --router=<router> --region=<region> \
  --min-ports-per-vm=1024 --enable-logging --log-filter=ERRORS_ONLY
```

Size it above the most connections the VM can open to one member: the driver's
`maxPoolSize` (100 by default) times the number of backend processes, plus
backups and one-off clients. Dynamic port allocation also works. Turn on
error logging either way, so a future exhaustion shows up as
`OUT_OF_RESOURCES` drops in Cloud Logging instead of as silent timeouts.

Verify with a fresh client, such as a one-off container that connects and runs
`ping`, and a TCP connect to every member.

## Keep it from creeping back

Alert when established connections to any single member pass about 80% of the
per-VM port allocation. A pool that has grown toward the limit gives no other
sign until the next restart.
