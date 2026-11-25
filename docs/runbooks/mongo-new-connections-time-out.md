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
gives each VM a number of source ports **per destination IP and port**. With
static port allocation (the default) that number is fixed, and an unset
`minPortsPerVm` means **64**. With dynamic port allocation, an unset minimum
means 32 and the allocation can grow toward the configured maximum. Every
connection the VM holds to a given Mongo member uses one of those ports.

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

# every container on the host, with the conntrack tool
conntrack -L -p tcp --dport 27017 --state ESTABLISHED 2>/dev/null \
  | grep -o 'dst=[0-9.]*' | awk 'NR%2==1' | sort | uniq -c

# without the tool, from the proc file (only if /proc/net/nf_conntrack exists)
grep 'dport=27017 ' /proc/net/nf_conntrack | grep ESTABLISHED \
  | grep -o 'dst=[0-9.]*' | awk 'NR%2==1' | sort | uniq -c
```

Empty output from either means the source was unavailable, not zero
connections. Check that the command can read connection tracking before you
trust a blank.

If one member sits at or near the NAT's per-VM port count while the others hold
a handful, this is the cause.

A low count does not rule it out. Cloud NAT keeps a closed connection's port
reserved until its `TIME_WAIT` timeout ends, so a client that opens and closes
connections quickly can fill the allocation while few are established. Read
the NAT gateway's port-usage and dropped-sent-packets metrics for the same
period before you clear the NAT.

Then confirm the NAT's settings:

```bash
gcloud compute routers nats describe <nat> --router=<router> --region=<region> \
  --format='value(minPortsPerVm,enableDynamicPortAllocation,maxPortsPerVm,natIpAllocateOption,logConfig.enable)'
```

With static allocation, an empty `minPortsPerVm` means 64. With dynamic
allocation it means 32, and the ports actually allocated can be higher, so
compare your counts against the allocation, not the minimum.

## Fix

Raise the per-VM port allocation. Nothing restarts, and the change takes effect
in seconds. Check two things first:

- **Only raise it.** Read the current `minPortsPerVm` above. Lowering a static
  minimum breaks established NAT connections at once. If the current value is
  already at or above what you need, enable dynamic port allocation instead,
  with a `--max-ports-per-vm` that is a power of 2, at least 1024 and greater
  than the current minimum: a lower maximum drops existing connections. Cloud
  NAT refuses dynamic allocation while endpoint-independent mapping is on, so
  check `enableEndpointIndependentMapping` first.
- **Raise the maximum with the minimum, never lower it.** With dynamic
  allocation already on, the maximum must stay above the minimum. If
  `maxPortsPerVm` is at or below the new minimum, raise it to a higher power of
  2 (2048 for a 1024 minimum) in the same update. Never set it below its current
  value: lowering a dynamic maximum breaks active connections. With static
  allocation, leave the maximum unset.
- **NAT addresses.** More ports per VM can need more NAT IP addresses. With
  automatic allocation (`AUTO_ONLY`), Cloud NAT picks any new addresses itself,
  so you cannot know them in advance. If the database restricts clients by IP,
  connections from a new address are refused, and look like the same timeouts,
  until it is on the access list. Right after the change, list the addresses the
  NAT is using (`gcloud compute routers get-nat-ip-info <router> --region=<region>`)
  and add any new one to the access list. Cloud NAT can add another address
  later as demand grows, so repeat that check after load changes. If the
  database needs a fixed address list, the NAT has to use manual allocation; with manual
  allocation, assign enough addresses before raising the minimum. The
  Cloud NAT "ports and addresses" documentation gives the count a minimum
  needs. One VM at 1024 ports fits in a single address.

```bash
gcloud compute routers nats update <nat> --router=<router> --region=<region> \
  --min-ports-per-vm=1024 --enable-logging --log-filter=ERRORS_ONLY
```

Size it above the most connections the VM can open to one member: the driver's
`maxPoolSize` (100 by default) times the number of backend processes, plus
backups and one-off clients. Dynamic port allocation also works. Turn on
error logging either way: dropped connections then appear in Cloud Logging as
NAT log entries with allocation status `DROPPED`, and the gateway's
dropped-sent-packets metric reports them with reason `OUT_OF_RESOURCES`,
instead of showing up only as silent timeouts.

Verify with a fresh client, such as a one-off container that connects and runs
`ping`, and a TCP connect to every member.

## Keep it from creeping back

Alert when established connections to any single member pass about 80% of the
per-VM port allocation. A pool that has grown toward the limit gives no other
sign until the next restart.
