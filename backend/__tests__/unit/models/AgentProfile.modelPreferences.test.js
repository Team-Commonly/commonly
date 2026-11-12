// F105: a new profile's modelPreferences named `gemini-2.5-pro` and
// `gemini-2.5-flash`. It now names the configured default and no fallback.
// Nothing routes on the field; it is stored and returned with the profile.
const mongoose = require('mongoose');
const AgentProfile = require('../../../models/AgentProfile');

describe('AgentProfile modelPreferences defaults', () => {
  const saved = process.env.AGENT_DEFAULT_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_DEFAULT_MODEL;
    else process.env.AGENT_DEFAULT_MODEL = saved;
  });

  const profile = (extra = {}) => new AgentProfile({
    agentName: 'scout',
    podId: new mongoose.Types.ObjectId(),
    name: 'Scout',
    purpose: 'test',
    createdBy: new mongoose.Types.ObjectId(),
    ...extra,
  });

  it('names the configured default, read when the profile is made, and no fallback', () => {
    process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
    expect(profile().modelPreferences.preferred).toBe('claude-haiku-5-5');
    expect(profile().modelPreferences.fallback).toBe('');
  });

  it('names no Gemini model with the chart unset', () => {
    delete process.env.AGENT_DEFAULT_MODEL;
    const prefs = profile().modelPreferences;
    expect(prefs.preferred).toBe('deepseek-v4-flash');
    expect(`${prefs.preferred} ${prefs.fallback}`).not.toMatch(/gemini/);
  });

  it('keeps a preference the profile was given', () => {
    const p = profile({ modelPreferences: { preferred: 'gemini-2.5-pro', fallback: 'gemini-2.5-flash' } });
    expect(p.modelPreferences).toEqual(expect.objectContaining({ preferred: 'gemini-2.5-pro', fallback: 'gemini-2.5-flash' }));
  });
});
