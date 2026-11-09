type BackgroundServices = {
  scheduler: { start: () => void };
  discordGateway: { start: () => void };
  nativeQueue: { start: () => void };
};

export function startBackgroundServices(
  env: NodeJS.ProcessEnv,
  services: BackgroundServices,
): boolean {
  if (!shouldRunBackgroundServices(env)) return false;

  console.log('Starting summarizer scheduler...');
  services.scheduler.start();
  if (env.DISCORD_BOT_TOKEN) services.discordGateway.start();
  // F52: where the scheduler runs, native turns run under the runner lease, and
  // the queue holds the ones this process may not run: those web pods hand
  // over, and those that arrive while another pod still holds the lease.
  services.nativeQueue.start();
  return true;
}

export function shouldRunBackgroundServices(env: NodeJS.ProcessEnv): boolean {
  // Unset keeps single-process installs scheduling until the chart moves the
  // singleton work into its own Deployment.
  return env.NODE_ENV !== 'test' && env.RUN_WORKER !== '0';
}
