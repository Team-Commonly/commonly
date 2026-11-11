/**
 * F387: a cloud-codex k8s pod declares itself with this env var, set only by
 * k8s/helm/commonly/templates/agents/cloud-codex-deployment.yaml. bwrap can't
 * run in a standard k8s container and the pod is the boundary, so a Codex seat
 * there keeps the pod's execution policy. Anywhere else a private Codex seat
 * runs under the private permission profile (adapters/codex.js); on Linux it
 * is refused by default until that profile is walked there (host-check.js).
 *
 * Only the exact value "1" counts, so a missing or mistyped value lands on the
 * profile.
 */
export const CODEX_TRUSTED_PERIMETER_ENV = 'COMMONLY_CODEX_TRUSTED_PERIMETER';

export const codexTrustedPerimeter = (env = process.env) => (
  String(env?.[CODEX_TRUSTED_PERIMETER_ENV] ?? '').trim() === '1'
);
