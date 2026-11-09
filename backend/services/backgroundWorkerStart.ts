type BackgroundServices = {
  scheduler: { start: () => void };
  discordGateway: { start: () => void };
  nativeQueue: { start: () => void };
};

export function startBackgroundServices(
  env: NodeJS.ProcessEnv,
  services: BackgroundServices,
): boolean {
  // F52: every process that may run native turns runs them under the runner
  // lease, scheduler or not: a paused split's web pods surge beside each other
  // on every roll. The queue holds the turns this process may not run. A web
  // pod that hands its turns to the worker starts nothing here.
  if (env.NODE_ENV !== 'test') services.nativeQueue.start();
  if (!shouldRunBackgroundServices(env)) return false;

  console.log('Starting summarizer scheduler...');
  services.scheduler.start();
  if (env.DISCORD_BOT_TOKEN) services.discordGateway.start();
  return true;
}

export function shouldRunBackgroundServices(env: NodeJS.ProcessEnv): boolean {
  // Unset keeps single-process installs scheduling until the chart moves the
  // singleton work into its own Deployment.
  return env.NODE_ENV !== 'test' && env.RUN_WORKER !== '0';
}
