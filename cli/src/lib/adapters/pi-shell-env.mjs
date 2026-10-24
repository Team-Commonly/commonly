/**
 * Keep the provider key available to pi's per-call auth resolver, but out of
 * shells started by its model bash tool and by manual ! / !! commands.
 * This limits environment inheritance; pi itself is not an OS sandbox.
 */
import { createBashTool, createLocalBashOperations } from '@earendil-works/pi-coding-agent';

export default function commonlyShellEnvironment(pi) {
  const providerKey = process.env.COMMONLY_PI_PROVIDER_KEY_ENV;
  if (!providerKey) throw new Error('pi adapter: missing provider key environment name');
  const excluded = new Set([
    providerKey, 'COMMONLY_LITELLM_KEY', 'COMMONLY_PI_PROVIDER_KEY_ENV',
  ].map((key) => key.toUpperCase()));
  const cleanEnv = (env) => {
    const clean = { ...env };
    // Windows environment lookup ignores case; spreading it loses that behavior.
    for (const key of Object.keys(clean)) {
      if (excluded.has(key.toUpperCase())) delete clean[key];
    }
    return clean;
  };
  const spawnHook = (context) => ({ ...context, env: cleanEnv(context.env) });
  const bash = createBashTool(process.cwd(), { spawnHook });
  pi.registerTool({
    ...bash,
    execute(id, params, signal, onUpdate, ctx) {
      return createBashTool(ctx.cwd, { spawnHook }).execute(id, params, signal, onUpdate, ctx);
    },
  });
  const local = createLocalBashOperations();
  pi.on('user_bash', () => ({
    operations: {
      exec(command, cwd, options) {
        return local.exec(command, cwd, {
          ...options,
          env: cleanEnv(options.env ?? process.env),
        });
      },
    },
  }));
}
