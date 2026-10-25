import React from 'react';
import type { PlaybookDefinition } from './playbookTypes';
import { useTranslation } from 'react-i18next';

/** Consent comes from validated server parameters. A proposal's summary is not authority. */
const V2PlaybookConsent: React.FC<{ actionType: string; params: Record<string, unknown> }> = ({
  actionType,
  params,
}) => {
  const { t } = useTranslation();
  const definition = params.definition as PlaybookDefinition | undefined;
  if (actionType === 'create_playbook')
    return (
      <>
        <div className="v2-approval__action" data-testid="approval-action">
          {t('playbooks.consent.save', { title: String(params.title || '') })}
        </div>
        <p className="v2-approval__pitch">{t('playbooks.consent.saveOffHint')}</p>
        {Array.isArray(definition?.steps) && (
          <details>
            <summary>{t('playbooks.ui.steps')}</summary>
            <ol>
              {definition.steps.map((step) => (
                <li key={step.key}>
                  <strong>{step.title}</strong>
                  <p>{step.do}</p>
                  <small>
                    {step.role}
                    {step.reads?.length ? ` · ${step.reads.join(', ')}` : ''}
                    {step.approval ? ` · ${t('playbooks.ui.approver')}: ${step.approval.by}` : ''}
                  </small>
                </li>
              ))}
            </ol>
          </details>
        )}
        {typeof params.sourceText === 'string' && (
          <details>
            <summary>{t('playbooks.ui.source')}</summary>
            <p className="v2-playbooks__receipt">{params.sourceText}</p>
          </details>
        )}
      </>
    );
  const output = params.output as { url?: unknown; excerpt?: unknown; kind?: unknown } | null;
  // Receipts are server reconstructed, but still constrain links at the rendering boundary.
  const url =
    typeof output?.url === 'string' &&
    (/^\/v2\//.test(output.url) || /^https:\/\//.test(output.url))
      ? output.url
      : null;
  return (
    <>
      <div className="v2-approval__action" data-testid="approval-action">
        {t('playbooks.consent.step', {
          title: String(params.title || ''),
          run: String(params.runTaskId || ''),
        })}
      </div>
      {output && (
        <>
          {typeof output.excerpt === 'string' && (
            <blockquote className="v2-playbooks__receipt">{output.excerpt}</blockquote>
          )}
          {url && (
            <a
              href={url}
              target={url.startsWith('https:') ? '_blank' : undefined}
              rel="noopener noreferrer"
            >
              {t(output.kind === 'notes' ? 'playbooks.consent.notes' : 'playbooks.consent.output')}
            </a>
          )}
        </>
      )}
      <p className="v2-approval__pitch">
        {params.act === 'kernel'
          ? t('playbooks.consent.kernel')
          : params.writeGap
            ? t('playbooks.consent.manual', {
                person: String(params.actorLabel || t('playbooks.person')),
                channel:
                  String(params.writeGap).toLowerCase() === 'linkedin'
                    ? 'LinkedIn'
                    : String(params.writeGap),
              })
            : t('playbooks.consent.unlock')}
      </p>
    </>
  );
};
export default V2PlaybookConsent;
