type BackgroundServices = {
  scheduler: { start: () => void };
  discordGateway: { start: () => void };
};

export function startBackgroundServices(
  env: NodeJS.ProcessEnv,
  services: BackgroundServices,
): boolean {
  // Unset keeps single-process installs scheduling until the chart moves the
  // singleton work into its own Deployment.
  if (env.NODE_ENV === 'test' || env.RUN_WORKER === '0') return false;

  console.log('Starting summarizer scheduler...');
  services.scheduler.start();
  if (env.DISCORD_BOT_TOKEN) services.discordGateway.start();
  return true;
}
