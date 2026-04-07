interface HeartbeatEditorContentOptions {
  liveContent?: string;
  configChecklist?: string;
  fallback?: string;
}

export const resolveHeartbeatEditorContent = ({
  liveContent = '',
  configChecklist = '',
  fallback = '',
}: HeartbeatEditorContentOptions = {}): string => {
  const live = String(liveContent || '').trim();
  if (live) return live;

  const config = String(configChecklist || '').trim();
  if (config) return config;

  return fallback;
};
