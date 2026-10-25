export const PLAYBOOK_HANDLER = 'internal:playbook.start';

export const isPlaybook = (installable: any): boolean => (installable.components || [])
  .some((component: any) => component.eventHandler === PLAYBOOK_HANDLER);
