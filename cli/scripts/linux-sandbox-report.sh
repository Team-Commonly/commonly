#!/usr/bin/env bash
# What this host does to the CLI's bubblewrap jail, with Ubuntu's own AppArmor
# options measured against it. Runs on a throwaway CI runner (byo-linux.yml's
# sandbox-report job): it loads profiles, so never run it on a machine you keep.
set -u

jail() {
  node --input-type=module -e "
    import { spawnSync } from 'node:child_process';
    import { mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { detectBwrap, wrapArgvWithBwrap } from './cli/src/lib/sandbox/bwrap.js';
    const found = detectBwrap();
    console.log('detectBwrap:', JSON.stringify(found));
    const workspacePath = mkdtempSync(join(tmpdir(), 'jail-ws-'));
    const homePath = mkdtempSync(join(tmpdir(), 'jail-home-'));
    const [cmd, ...args] = wrapArgvWithBwrap(['sh', '-c', 'echo jail-ok; touch /usr/jail-escape 2>&1'], {}, { workspacePath, homePath });
    const run = spawnSync(cmd, args, { encoding: 'utf8' });
    console.log('jail exit', run.status, 'stdout:', JSON.stringify(run.stdout), 'stderr:', JSON.stringify(run.stderr));
    const net = wrapArgvWithBwrap(['true'], { sandbox: { network: { policy: 'restricted' } } }, { workspacePath, homePath, enableLoopback: true });
    const bridge = spawnSync(net[0], net.slice(1), { encoding: 'utf8' });
    console.log('loopback-bridge jail exit', bridge.status, 'stderr:', JSON.stringify(bridge.stderr));
  "
}

probe() {
  echo "--- $1"
  bwrap --unshare-all --ro-bind / / true
  echo "probe exit $?"
  jail
}

refusals() {
  node --input-type=module -e "
    import { hostSandboxRefusal } from './cli/src/lib/sandbox/host-check.js';
    for (const adapterName of ['claude', 'codex']) {
      console.log('--- what ' + adapterName + ' prints');
      console.log(hostSandboxRefusal({ environment: { sandbox: { trust: 'public' } }, adapterName, platform: 'linux' }));
    }
  "
}

profiles() {
  echo "$1: $(sudo aa-status --profiled) profiles, $(sudo aa-status --enforced) enforced, $(ls /etc/apparmor.d | wc -l) entries in /etc/apparmor.d"
}

sudo apt-get update -qq && sudo apt-get install -y -qq bubblewrap
(cd cli && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)

echo "=== host"
. /etc/os-release && echo "$PRETTY_NAME, kernel $(uname -r)"
bwrap --version
sysctl kernel.apparmor_restrict_unprivileged_userns kernel.unprivileged_userns_clone 2>&1
profiles "as the host came"

probe "as the host came"
refusals

if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" = 22.04 ]; then exit 0; fi

echo "=== the one profile, without the package"
dir=$(mktemp -d)
(cd "$dir" && apt-get download apparmor-profiles && dpkg-deb -x apparmor-profiles_*.deb x)
profile=/etc/apparmor.d/bwrap-userns-restrict
sudo cp "$dir/usr/share/apparmor/extra-profiles/bwrap-userns-restrict" "$profile"
sudo apparmor_parser -r "$profile" && probe "with bwrap-userns-restrict loaded"
profiles "with one profile"
sudo systemctl reload apparmor
profiles "after an AppArmor reload"
probe "after an AppArmor reload"
sudo apparmor_parser -R "$profile" && sudo rm "$profile"
probe "after undoing it"

echo "=== what the package would add"
before=$(ls /etc/apparmor.d)
sudo apt-get install -y -qq apparmor-profiles
comm -13 <(echo "$before" | sort) <(ls /etc/apparmor.d | sort) | tr '\n' ' '; echo
profiles "with the package, not reloaded"
sudo systemctl reload apparmor
profiles "with the package, after an AppArmor reload"
exit 0
