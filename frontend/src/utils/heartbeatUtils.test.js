import { resolveHeartbeatEditorContent } from './heartbeatUtils';

describe('resolveHeartbeatEditorContent', () => {
  it('prefers live heartbeat content from workspace', () => {
    const value = resolveHeartbeatEditorContent({
      liveContent: '# HEARTBEAT.md\n\nlive',
      configChecklist: 'config',
      fallback: 'fallback',
    });
    expect(value).toBe('# HEARTBEAT.md\n\nlive');
  });

  it('falls back to saved config checklist when live content is empty', () => {
    const value = resolveHeartbeatEditorContent({
      liveContent: '   ',
      configChecklist: 'saved config value',
      fallback: 'fallback',
    });
    expect(value).toBe('saved config value');
  });

  it('uses fallback when neither live nor saved content is available', () => {
    const value = resolveHeartbeatEditorContent({
      liveContent: '',
      configChecklist: '',
      fallback: 'fallback value',
    });
    expect(value).toBe('fallback value');
  });
});

