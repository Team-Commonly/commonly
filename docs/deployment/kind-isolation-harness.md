# kind isolation harness

`.github/workflows/kind-isolation.yml` installs the chart on a throwaway kind cluster and proves, with live
connections, that its isolation settings hold. A rendered NetworkPolicy proves nothing on its own: kind's default
CNI (kindnet) ignores NetworkPolicy, and so does any cluster whose CNI doesn't enforce it. The chart checks
(`scripts/verify-network-policy-chart.js`) prove what the chart *renders*. This harness proves what a cluster
running it *enforces*.

It runs on any PR that touches the network, agent-provisioning, database, backup or ops templates, the backend
Deployment, the values it layers, or the harness itself, and on `workflow_dispatch`. It needs nothing outside a GitHub-hosted runner: no cloud account and no
image registry.

## What it sets up

| Piece | Why | Pin |
|---|---|---|
| kind v0.26.0, no default CNI, pod subnet `10.244.0.0/16` | a real API server and kubelet | binary sha256 |
| Calico v3.30.3 | enforces NetworkPolicy (the version OpenShell's own kind tests use) | manifest sha256; every image it names rewritten to its digest, checked before apply |
| gVisor `runsc` + `containerd-shim-runsc-v1` | the `runsc` handler, mounted into the node and registered with containerd | release tarball sha512 |
| agent-sandbox v1.0.3 (`Sandbox` CRD + controller) | the per-turn pod shape OpenShell's Kubernetes driver creates | manifest sha256; controller image by digest |
| a canary (`agnhost netexec`) on the kind Docker network | stands in for a metadata server: an address in `egress.restrict.exceptCidrs` | image by digest |
| the chart, with `values.yaml` + `values-local.yaml` + `values-kind-isolation.yaml` | the backend, ops-runner and in-cluster Mongo, Postgres and Redis under every policy | backend built from the PR |

`values-kind-isolation.yaml` contains nothing that works only on kind. The RuntimeClass
(`templates/agent-provisioning/runtime-class.yaml`, off by default) and the policies are standard objects. On GKE,
GKE Sandbox ships its own `gvisor` RuntimeClass, so `runtimeClass.gvisor.create` stays false there.

## What `scripts/kind-isolation/probe.sh` proves

Every probe runs from a throwaway `agnhost` pod with no service-account token.

- **Ingress.** Each store (Mongo, Postgres, Redis) and the backend admits a listed client (`app=ops-runner`) and
  drops an unlisted pod. An agent workload (`app=commonly-bot`) reaches the backend but not Mongo. The edge reaches
  the backend. The backup component reaches Mongo. A pod in another namespace that copies a client's label is
  dropped.
- **Egress.** The canary is dropped for an ordinary pod and reachable from the exempt backup component.
- **The sandboxed agent pod.** A pod under gVisor with a listed client label reaches Mongo, so gVisor's own
  networking works. A `Sandbox` whose pod runs under gVisor is then dropped at every store, the backend and the
  canary.
- **gVisor.** The RuntimeClass uses the `runsc` handler. A pod under it, and the Sandbox's pod, report gVisor's
  own kernel string (`Linux version 4.19.0-gvisor` in the pinned release), not the node's.

A probe expected to be closed passes only on a connect **timeout**, which is what a dropped packet looks like. A
DNS failure or a refused port can't pass as enforcement. Every closed path is paired with an open one from an
allowed client, so a cluster that drops everything fails too.

## What it does not prove

- **Pinning is partial.** Downloads and the Calico, agent-sandbox and probe images are pinned by checksum or
  digest. The chart's store images (`mongo`, `postgres`, `redis` in `values-local.yaml`), the kind node image and
  the setup actions come by tag. The job holds a read-only token and no secrets.

- **OpenShell itself.** The OpenClaw gateway runtime is retired and its image is no longer built, so the harness
  doesn't provision a gateway. It probes the pod shape a sandboxed turn uses instead. Running OpenShell's sandbox
  under gVisor is a separate check: its sandbox relies on Landlock and nested seccomp user-notify, and gVisor's
  support for both has to be verified before that pairing is claimed.
- **Another cluster's enforcement.** The policy objects are standard, but whether a given cluster enforces them
  depends on its CNI. This harness proves Calico's.
- **The backend's own egress needs.** The profile turns `egress.restrict` on with only the metadata address and
  the canary excepted. A deployment that cuts more must re-check the backend's outbound calls.

## Running it on your own machine

On an x86_64 Linux host with Docker, follow the workflow's steps in order (the gVisor tarball it pins is
x86_64). The steps only need kind, kubectl, helm, curl, `sha256sum` and `sha512sum`, with the pins taken from
the workflow's `env:` block. Tear down with `kind delete cluster --name commonly-isolation` and
`docker rm -fv isolation-canary`.
