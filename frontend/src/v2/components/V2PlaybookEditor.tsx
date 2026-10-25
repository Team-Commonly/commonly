import { useTranslation } from 'react-i18next';
import React, { useState } from 'react';
import type { Playbook, PlaybookDefinition, PlaybookOptions } from './playbookTypes';

interface Props {
  book: Playbook;
  options: PlaybookOptions;
  disabled: boolean;
  save: (draft: Record<string, unknown>) => Promise<void>;
}
const V2PlaybookEditor: React.FC<Props> = ({ book, options, disabled, save }) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState(book.title);
  const [source, setSource] = useState(book.sourceText);
  const [definition, setDefinition] = useState<PlaybookDefinition>(
    JSON.parse(JSON.stringify(book.definition)),
  );
  const [frequency, setFrequency] = useState(
    book.schedule ? book.schedule.cron.split(' ')[4] : 'run',
  );
  const [time, setTime] = useState(
    book.schedule
      ? `${book.schedule.cron.split(' ')[1].padStart(2, '0')}:${book.schedule.cron.split(' ')[0].padStart(2, '0')}`
      : '09:00',
  );
  const [timezone, setTimezone] = useState(
    book.schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const updateStep = (index: number, patch: Partial<PlaybookDefinition['steps'][number]>) =>
    setDefinition({
      ...definition,
      steps: definition.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const [hour, minute] = time.split(':').map(Number);
    await save({
      title,
      sourceText: source,
      definition,
      bindings: Object.fromEntries(
        Object.entries(book.bindings).filter(([key, id]) =>
          definition.roles.some(
            (role) =>
              role.key === key &&
              options.members.some((person) => person.userId === id && person.kind === role.kind),
          ),
        ),
      ),
      ...(frequency !== 'run'
        ? { schedule: { cron: `${minute} ${hour} * * ${frequency}`, timezone } }
        : {}),
    });
  };
  return (
    <details className="v2-playbooks__panel">
      <summary>{t('playbooks.ui.edit')}</summary>
      <form onSubmit={submit}>
        <fieldset disabled={disabled}>
          <p>{t('playbooks.ui.editHint')}</p>
          <label>
            {t('playbooks.ui.name')}
            <input
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <div className="v2-playbooks__form">
            <label>
              {t('playbooks.ui.trigger')}
              <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                <option value="run">{t('playbooks.ui.run')}</option>
                <option value="*">{t('playbooks.ui.daily')}</option>
                <option value="1-5">{t('playbooks.ui.weekdays')}</option>
                {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                  (day, i) => (
                    <option key={day} value={i}>
                      {day}
                    </option>
                  ),
                )}
              </select>
            </label>
            {frequency !== 'run' && (
              <>
                <label>
                  {t('playbooks.ui.time')}
                  <input
                    required
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                </label>
                <label>
                  {t('playbooks.ui.timezone')}
                  <input required value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                </label>
              </>
            )}
          </div>
          <h3>{t('playbooks.ui.roles')}</h3>
          {definition.roles.map((role, index) => (
            <div key={index} className="v2-playbooks__form">
              <label>
                {t('playbooks.ui.roleKey')}
                <input
                  required
                  pattern="[a-z][a-z0-9-]{0,39}"
                  value={role.key}
                  onChange={(e) => {
                    const key = e.target.value;
                    setDefinition({
                      ...definition,
                      roles: definition.roles.map((item, i) =>
                        i === index ? { ...item, key } : item,
                      ),
                      steps: definition.steps.map((step) => ({
                        ...step,
                        role: step.role === role.key ? key : step.role,
                        ...(step.approval
                          ? {
                              approval: {
                                ...step.approval,
                                by: step.approval.by === role.key ? key : step.approval.by,
                              },
                            }
                          : {}),
                      })),
                    });
                  }}
                />
              </label>
              <label>
                {t('playbooks.ui.kind')}
                <select
                  value={role.kind}
                  onChange={(e) =>
                    setDefinition({
                      ...definition,
                      roles: definition.roles.map((item, i) =>
                        i === index
                          ? { ...item, kind: e.target.value as 'person' | 'agent' }
                          : item,
                      ),
                    })
                  }
                >
                  <option value="agent">{t('playbooks.ui.agent')}</option>
                  <option value="person">{t('playbooks.ui.person')}</option>
                </select>
              </label>
            </div>
          ))}
          <button
            type="button"
            disabled={definition.roles.length >= 24}
            onClick={() =>
              setDefinition({
                ...definition,
                roles: [
                  ...definition.roles,
                  { key: `role-${definition.roles.length + 1}`, kind: 'agent' },
                ],
              })
            }
          >
            {t('playbooks.ui.addRole')}
          </button>
          <h3>{t('playbooks.ui.steps')}</h3>
          {definition.steps.map((step, index) => (
            <section key={index} className="v2-playbooks__panel">
              <div className="v2-playbooks__form">
                <label>
                  {t('playbooks.ui.stepKey')}
                  <input
                    required
                    pattern="[a-z][a-z0-9-]{0,39}"
                    value={step.key}
                    onChange={(e) => {
                      const key = e.target.value;
                      setDefinition({
                        ...definition,
                        steps: definition.steps.map((item, i) =>
                          i === index ? { ...item, key } : item,
                        ),
                        done: definition.done.map((check) =>
                          check.step === step.key ? { ...check, step: key } : check,
                        ),
                      });
                    }}
                  />
                </label>
                <label>
                  {t('playbooks.ui.stepTitle')}
                  <input
                    required
                    maxLength={160}
                    value={step.title}
                    onChange={(e) => updateStep(index, { title: e.target.value })}
                  />
                </label>
                <label>
                  {t('playbooks.ui.role')}
                  <select
                    value={step.role}
                    onChange={(e) => updateStep(index, { role: e.target.value })}
                  >
                    {definition.roles.map((role) => (
                      <option key={role.key}>{role.key}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('playbooks.ui.output')}
                  <select
                    value={step.delivers || ''}
                    onChange={(e) =>
                      updateStep(index, {
                        delivers: (e.target.value || undefined) as 'post' | 'pr' | undefined,
                      })
                    }
                  >
                    <option value="">{t('playbooks.ui.notes')}</option>
                    <option value="post">{t('playbooks.ui.post')}</option>
                    <option value="pr">{t('playbooks.ui.pr')}</option>
                  </select>
                </label>
              </div>
              <label>
                {t('playbooks.ui.instructions')}
                <textarea
                  required
                  maxLength={8000}
                  value={step.do}
                  onChange={(e) => updateStep(index, { do: e.target.value })}
                />
              </label>
              <label>
                {t('playbooks.ui.reads')}
                <select
                  multiple
                  value={step.reads || []}
                  onChange={(e) =>
                    updateStep(index, {
                      reads: Array.from(e.target.selectedOptions, (option) => option.value),
                    })
                  }
                >
                  {Array.from(
                    new Set([
                      ...options.tools
                        .filter((tool) => tool.mode === 'read')
                        .map((tool) => tool.name),
                      ...(step.reads || []),
                    ]),
                  ).map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <label>
                {t('playbooks.ui.approval')}
                <select
                  value={step.approval?.act || ''}
                  onChange={(e) =>
                    updateStep(index, {
                      approval: e.target.value
                        ? {
                            by: definition.roles.find((role) => role.kind === 'person')?.key || '',
                            act: e.target.value as 'actor' | 'kernel',
                            effect: 'none',
                          }
                        : undefined,
                    })
                  }
                >
                  <option value="">{t('playbooks.ui.noPoint')}</option>
                  <option value="actor">{t('playbooks.ui.actor')}</option>
                  <option value="kernel">{t('playbooks.ui.kernel')}</option>
                </select>
              </label>
              {step.approval && (
                <label>
                  {t('playbooks.ui.approver')}
                  <select
                    value={step.approval.by}
                    required
                    onChange={(e) =>
                      updateStep(index, { approval: { ...step.approval!, by: e.target.value } })
                    }
                  >
                    <option value="">{t('playbooks.ui.choosePerson')}</option>
                    {definition.roles
                      .filter((role) => role.kind === 'person')
                      .map((role) => (
                        <option key={role.key}>{role.key}</option>
                      ))}
                  </select>
                </label>
              )}
              <label>
                {t('playbooks.ui.location')}
                <input
                  maxLength={80}
                  value={step.writeGap || ''}
                  placeholder="For example LinkedIn"
                  onChange={(e) => updateStep(index, { writeGap: e.target.value || undefined })}
                />
              </label>
              <button
                type="button"
                disabled={definition.steps.length === 1}
                onClick={() =>
                  setDefinition({
                    ...definition,
                    steps: definition.steps.filter((_, i) => i !== index),
                    done: definition.done.filter((check) => check.step !== step.key),
                  })
                }
              >
                {t('playbooks.ui.removeStep')}
              </button>
            </section>
          ))}
          <button
            type="button"
            disabled={definition.steps.length >= 64}
            onClick={() =>
              setDefinition({
                ...definition,
                steps: [
                  ...definition.steps,
                  {
                    key: `step-${definition.steps.length + 1}`,
                    title: '',
                    role: definition.roles[0].key,
                    do: '',
                  },
                ],
              })
            }
          >
            {t('playbooks.ui.addStep')}
          </button>
          <h3>{t('playbooks.ui.done')}</h3>
          {definition.done.map((check, index) => (
            <div className="v2-playbooks__form" key={index}>
              <label>
                {t('playbooks.ui.statement')}
                <input
                  required
                  maxLength={240}
                  value={check.says}
                  onChange={(e) =>
                    setDefinition({
                      ...definition,
                      done: definition.done.map((item, i) =>
                        i === index ? { ...item, says: e.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <label>
                {t('playbooks.ui.evidence')}
                <select
                  value={check.check}
                  onChange={(e) =>
                    setDefinition({
                      ...definition,
                      done: definition.done.map((item, i) =>
                        i === index
                          ? { ...item, check: e.target.value as typeof check.check }
                          : item,
                      ),
                    })
                  }
                >
                  {['done', 'approved', 'by-person', 'has-pr'].map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <label>
                {t('playbooks.ui.step')}
                <select
                  value={check.step}
                  onChange={(e) =>
                    setDefinition({
                      ...definition,
                      done: definition.done.map((item, i) =>
                        i === index ? { ...item, step: e.target.value } : item,
                      ),
                    })
                  }
                >
                  {definition.steps.map((item) => (
                    <option key={item.key}>{item.key}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={definition.done.length === 1}
                onClick={() =>
                  setDefinition({
                    ...definition,
                    done: definition.done.filter((_, i) => i !== index),
                  })
                }
              >
                {t('playbooks.ui.removeCheck')}
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={definition.done.length >= 64}
            onClick={() =>
              setDefinition({
                ...definition,
                done: [
                  ...definition.done,
                  { says: '', check: 'done', step: definition.steps[0].key },
                ],
              })
            }
          >
            {t('playbooks.ui.addCheck')}
          </button>
          <label>
            {t('playbooks.ui.source')}
            <textarea maxLength={8000} value={source} onChange={(e) => setSource(e.target.value)} />
          </label>
          <button type="submit">{t('playbooks.ui.saveOff')}</button>
        </fieldset>
      </form>
    </details>
  );
};
export default V2PlaybookEditor;
