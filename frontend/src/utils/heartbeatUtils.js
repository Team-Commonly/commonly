export const resolveHeartbeatEditorContent = ({
  liveContent = '',
  configChecklist = '',
  fallback = '',
} = {}) => {
  const live = String(liveContent || '').trim();
  if (live) return live;

  const config = String(configChecklist || '').trim();
  if (config) return config;

  return fallback;
};

