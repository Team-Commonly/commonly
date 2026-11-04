// D247: the model and effort a seat spawns with.
//
// Two rules live here so the run loop and its tests share them:
//
// 1. A listener seat (`agent run` with no daemon behind it) reads the model and
//    effort its owner saved in Settings or on the add page from
//    GET /api/agents/runtime/installations before each turn. A saved value
//    replaces the one in the local record; an absent one leaves it alone, so an
//    older server changes nothing.
// 2. An effort is dropped only when the device reported a NON-EMPTY list of
//    levels that leaves it out. A device that reported nothing says nothing
//    about the level, so the level is passed through and the harness decides.

const isControl = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

const controlsOf = (row) => {
  const controls = {};
  if (isControl(row.runtimeControls.model)) controls.model = row.runtimeControls.model;
  if (isControl(row.runtimeControls.effort)) controls.effort = row.runtimeControls.effort;
  return Object.keys(controls).length ? controls : null;
};

/**
 * The saved controls for this seat, or null when none are reported.
 *
 * A server that names `runtimeSourcePodId` (the installation Settings reads)
 * is followed exactly: that row's controls, or null when it has none or the
 * server names no source. An older server names none, and the seat reads its
 * own pod's row, then any row of this instance that has controls.
 */
export const savedRuntimeControls = ({ installations, podId, instanceId, runtimeSourcePodId } = {}) => {
  if (!Array.isArray(installations)) return null;
  const rows = installations.filter((row) => row?.type === 'installation'
    && row.runtimeControls && typeof row.runtimeControls === 'object');
  const wantedInstance = String(instanceId || 'default');
  if (runtimeSourcePodId !== undefined) {
    const source = runtimeSourcePodId === null ? null
      : rows.find((entry) => String(entry.podId || '') === String(runtimeSourcePodId)
        && String(entry.instanceId || 'default') === wantedInstance);
    return source ? controlsOf(source) : null;
  }
  // /installations returns runtimeControls on every row, `{}` when nothing is
  // saved, so both matches require a value: an empty row in this pod must not
  // hide the controls saved on the identity's other installation.
  const hasControls = (entry) => isControl(entry.runtimeControls.model) || isControl(entry.runtimeControls.effort);
  const row = rows.find((entry) => String(entry.podId || '') === String(podId || '')
    && String(entry.instanceId || 'default') === wantedInstance && hasControls(entry))
    || rows.find((entry) => String(entry.instanceId || 'default') === wantedInstance && hasControls(entry));
  return row ? controlsOf(row) : null;
};

/** The environment with saved controls laid over it. A null environment stays null. */
export const withSavedRuntimeControls = (environment, controls) => {
  if (!environment || typeof environment !== 'object' || !controls) return environment;
  return { ...environment, ...controls };
};

/** True only when the device listed its effort levels and this one is not among them. */
export const effortRefusedByDevice = (inventory, effort) => Boolean(effort)
  && Array.isArray(inventory?.efforts) && inventory.efforts.length > 0
  && !inventory.efforts.includes(effort);
