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
  "
}

probe() {
  echo "--- $1"
  bwrap --unshare-all --ro-bind / / true
  echo "probe exit $?"
  jail
}

sudo apt-get update -qq && sudo apt-get install -y -qq bubblewrap apparmor-utils apparmor-profiles

echo "=== host"
. /etc/os-release && echo "$PRETTY_NAME, kernel $(uname -r)"
bwrap --version
sysctl kernel.apparmor_restrict_unprivileged_userns kernel.unprivileged_userns_clone 2>&1
ls /etc/apparmor.d | grep -iE 'bwrap|unpriv' || echo "no bwrap profile in /etc/apparmor.d"
ls /usr/share/apparmor/extra-profiles 2>/dev/null | grep -iE 'bwrap|unpriv' || echo "no bwrap profile in extra-profiles"

probe "as the host came"

extra=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict
if [ -f "$extra" ]; then
  echo "=== Ubuntu's bwrap-userns-restrict"
  cat "$extra"
  sudo apparmor_parser -r "$extra" && probe "with bwrap-userns-restrict loaded"
  sudo apparmor_parser -R "$extra"
fi

echo "=== a profile that grants bwrap userns and nothing else changes"
narrow=$(mktemp)
cat > "$narrow" <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
sudo apparmor_parser -r "$narrow" && probe "with the userns grant loaded"
sudo apparmor_parser -R "$narrow"
exit 0
