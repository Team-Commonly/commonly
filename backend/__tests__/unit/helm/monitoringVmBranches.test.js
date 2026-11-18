/**
 * Prod moved to a single VM on 2026-11-18 (D323). Its container lines reach Cloud
 * Logging through the host's logging agent, as the docker_containers log on a
 * gce_instance resource, so a metric or policy that matches only k8s_container
 * goes blind there. These pin the VM branch on each signal that has a VM producer,
 * so the next apply-alerting run cannot revert the live repoint.
 */
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '../../../..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(repo, 'k8s/monitoring', f), 'utf8'));
const VM = 'resource.type="gce_instance" AND log_id("docker_containers")';

describe('alerting reads the single-VM deploy too', () => {
  const metrics = read('log-metrics.json');
  const policies = read('alert-policies.json');

  test.each([
    ['ingress_5xx', 'jsonPayload.status>=500'],
    ['litellm_platform_call_failures', 'POST /chat/completions'],
    ['model_fallback', 'jsonPayload.alarm="model_fallback"'],
    ['user_spend_over_threshold', 'jsonPayload.alarm="user_spend"'],
    ['litellm_key_budget_near_limit', 'jsonPayload.alarm="litellm_budget"'],
    ['litellm_guardrail_blocks', 'jsonPayload.log=~"WARNING: content_filter.py:[0-9]+ - Content blocked"'],
    ['stranger_journey_passes', 'jsonPayload.attrs."com.docker.compose.service"="stranger-journey"'],
    ['stranger_journey_failures', 'jsonPayload.attrs."com.docker.compose.service"="stranger-journey"'],
  ])('%s keeps its cluster branch and adds a VM branch', (name, marker) => {
    const { filter } = metrics.find((m) => m.name === name);
    expect(filter).toContain('resource.type="k8s_container"');
    const vm = filter.slice(filter.indexOf(VM));
    expect(filter).toContain(VM);
    expect(vm).toContain(marker);
  });

  test.each([
    'ingress_5xx', 'litellm_platform_call_failures', 'user_spend_over_threshold', 'litellm_key_budget_near_limit',
    'stranger_journey_failures',
  ])('the %s policy accepts the VM resource', (name) => {
    const filters = policies.flatMap((p) => p.conditions.map((c) => c.conditionThreshold?.filter || ''))
      .filter((f) => f.includes(`logging.googleapis.com/user/${name}"`));
    expect(filters).toHaveLength(1);
    expect(filters[0]).toContain('resource.type=one_of("k8s_container","gce_instance")');
  });

  // One run a day since prod moved to the single VM. A metric-absence condition caps at 23h30m, so the
  // 'not passed' alert is a PromQL count over 25 h, the longest lookback a
  // log-based metric allows: one day plus an hour of slack for the run itself.
  test('the not-passed alert counts the VM\'s passes over 25 h', () => {
    const p = policies.find((x) => x.displayName === 'commonly-dev: the stranger journey has not passed in 25 h');
    const q = p.conditions[0].conditionPrometheusQueryLanguage.query;
    // A metric on two resource types needs a monitored_resource matcher in
    // PromQL. The GKE CronJob is suspended, so only the VM's runs count.
    expect(q).toContain('logging_googleapis_com:user_stranger_journey_passes{monitored_resource="gce_instance"}[25h]');
    expect(q).toContain('or on() vector(0)');
  });

  // GKE serves nothing since the cutover; these read only Kubernetes state and
  // paged on deliberately scaled-to-zero deployments. Disabled, not deleted,
  // until the teardown. apply-alerting must keep them off.
  test.each([
    'a deployment has no available replicas', 'container crash-looping or failing to start',
    'node memory above 85%', 'container restarting repeatedly', 'pod pending for 10 minutes',
    'a Job or CronJob failed', 'secret sync failing',
    // apply-alerting matches on displayName, so the renamed alert keeps its old
    // entry, disabled, or the next apply leaves the GKE-only one paging.
    'the stranger journey has not passed in 23 h',
  ])('cluster-only policy "%s" stays disabled', (title) => {
    const p = policies.find((x) => x.displayName === `commonly-dev: ${title}`);
    expect(p.enabled).toBe(false);
  });
});

