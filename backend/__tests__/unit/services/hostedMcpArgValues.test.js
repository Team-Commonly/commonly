// F100: a read pin's argument VALUES are checked against the pinned schema
// before a call. Names were already checked (`assertNoUnknown`); a value of the
// wrong type, or outside a pinned enum, used to reach the vendor unchanged.
// eslint-disable-next-line import/no-unresolved, import/extensions
const { assertPinnedArgValues } = require('../../../services/hostedMcpArgValues');
// eslint-disable-next-line import/no-unresolved, import/extensions
const { HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');
// eslint-disable-next-line import/no-unresolved, import/extensions
const { entryToolProjections } = require('../../../services/hostedMcpEntryService');

const readPin = (inputSchema) => ({ name: 'acme.read_thing', requiredWriteMode: 'read', inputSchema });

const refusal = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

describe('hosted-MCP read-pin argument values (F100)', () => {
  const ENUM_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['issue', 'event'] },
      limit: { type: 'integer', minimum: 1 },
    },
    required: ['kind'],
  };

  it('refuses a value outside a pinned enum, naming the argument and not echoing the value', () => {
    const error = refusal(() => assertPinnedArgValues(readPin(ENUM_SCHEMA), { kind: 'secret-route-x' }));
    expect(error).toMatchObject({ code: 'invalid_tool_args', statusCode: 400 });
    expect(error.message).toContain('kind');
    expect(error.message).not.toContain('secret-route-x');
  });

  it('refuses a value of the wrong type', () => {
    const error = refusal(() => assertPinnedArgValues(readPin(ENUM_SCHEMA), { kind: 'issue', limit: 'all' }));
    expect(error).toMatchObject({ code: 'invalid_tool_args' });
    expect(error.message).toContain('limit');
  });

  it('refuses a call missing a pinned required argument', () => {
    expect(refusal(() => assertPinnedArgValues(readPin(ENUM_SCHEMA), {})))
      .toMatchObject({ code: 'invalid_tool_args' });
  });

  it('passes values the pin allows, unchanged', () => {
    const args = { kind: 'event', limit: 5 };
    expect(() => assertPinnedArgValues(readPin(ENUM_SCHEMA), args)).not.toThrow();
    expect(args).toEqual({ kind: 'event', limit: 5 });
  });

  it('reads a draft-07 pin and a pin with no $schema the same way', () => {
    const { $schema, ...bare } = ENUM_SCHEMA;
    const draft7 = { ...bare, $schema: 'http://json-schema.org/draft-07/schema#' };
    for (const schema of [draft7, bare]) {
      expect(refusal(() => assertPinnedArgValues(readPin(schema), { kind: 'other' })))
        .toMatchObject({ code: 'invalid_tool_args' });
      expect(() => assertPinnedArgValues(readPin(schema), { kind: 'issue' })).not.toThrow();
    }
  });

  it('names only the top-level argument below it, never a key the model chose', () => {
    const schema = {
      type: 'object',
      properties: {
        filters: { type: 'object', additionalProperties: { type: 'string' } },
        issue: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    };
    const mapped = refusal(() => assertPinnedArgValues(readPin(schema), { filters: { 'model-chosen-key': 3 } }));
    expect(mapped).toMatchObject({ code: 'invalid_tool_args' });
    expect(mapped.message).toContain('filters');
    expect(mapped.message).not.toContain('model-chosen-key');
    const nested = refusal(() => assertPinnedArgValues(readPin(schema), { issue: {} }));
    expect(nested.message).toBe('tool argument issue: is missing its required field id');
  });

  it('compiles a schema once by its text, whatever object carries it', () => {
    const fresh = () => JSON.parse(JSON.stringify(ENUM_SCHEMA));
    const Ajv2020 = require('ajv/dist/2020').default;
    const compile = jest.spyOn(Ajv2020.prototype, 'compile');
    assertPinnedArgValues(readPin(fresh()), { kind: 'issue' });
    const after = compile.mock.calls.length;
    assertPinnedArgValues(readPin(fresh()), { kind: 'event' });
    expect(compile.mock.calls.length).toBe(after);
    compile.mockRestore();
  });

  it('ignores an unknown format rather than refusing the call', () => {
    const schema = { type: 'object', properties: { at: { type: 'string', format: 'vendor-time' } } };
    expect(() => assertPinnedArgValues(readPin(schema), { at: 'whenever' })).not.toThrow();
  });

  it('leaves a write pin to its approval, unchanged', () => {
    const write = { ...readPin(ENUM_SCHEMA), requiredWriteMode: 'write-with-confirm' };
    expect(() => assertPinnedArgValues(write, { kind: 'other' })).not.toThrow();
  });

  it('refuses the shipped Sentry resource pin outside its resource types', () => {
    const sentry = HOSTED_MCP_ENTRIES.find((entry) => entry.id === 'sentry');
    const definition = entryToolProjections(sentry).find((tool) => tool.name === 'sentry.get_sentry_resource');
    expect(definition.requiredWriteMode).toBe('read');
    const error = refusal(() => assertPinnedArgValues(definition, { resourceType: 'not-a-pinned-type', resourceId: '1' }));
    expect(error).toMatchObject({ code: 'invalid_tool_args' });
    expect(error.message).toContain('resourceType');
  });

  // The validator is compiled per pin. A pin it cannot read would refuse every
  // call to that tool, so each shipped read pin must compile here, in CI.
  it('compiles every shipped read pin', () => {
    const reads = HOSTED_MCP_ENTRIES.flatMap((entry) => entryToolProjections(entry))
      .filter((definition) => definition.requiredWriteMode === 'read');
    expect(reads.length).toBeGreaterThan(40);
    for (const definition of reads) {
      const error = refusal(() => assertPinnedArgValues(definition, {}));
      // A missing required argument is a refusal on the args; a schema the
      // validator could not compile is a different message, and fails here.
      if (error) expect(`${definition.name}: ${error.message}`).not.toMatch(/cannot be checked/);
    }
  });
});
