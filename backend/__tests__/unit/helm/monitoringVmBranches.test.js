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
  ])('%s keeps its cluster branch and adds a VM branch', (name, marker) => {
    const { filter } = metrics.find((m) => m.name === name);
    expect(filter).toContain('resource.type="k8s_container"');
    const vm = filter.slice(filter.indexOf(VM));
    expect(filter).toContain(VM);
    expect(vm).toContain(marker);
  });

  test.each([
    'ingress_5xx', 'litellm_platform_call_failures', 'user_spend_over_threshold', 'litellm_key_budget_near_limit',
  ])('the %s policy accepts the VM resource', (name) => {
    const filters = policies.flatMap((p) => p.conditions.map((c) => c.conditionThreshold?.filter || ''))
      .filter((f) => f.includes(`logging.googleapis.com/user/${name}"`));
    expect(filters).toHaveLength(1);
    expect(filters[0]).toContain('resource.type=one_of("k8s_container","gce_instance")');
  });
});
