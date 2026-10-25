import React from 'react';
import type { V2Message } from '../hooks/useV2PodDetail';
import { BadgeView, CardLink, KeyValueView, ListView, TextView } from '../cards/cardViews';
import '../cards/uiCard.css';

type Element = { type: string; text?: unknown; href?: unknown; label?: unknown; value?: unknown; rows?: unknown; children?: unknown };
const safeGithubLink = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port
      ? url.toString() : null;
  } catch { return null; }
};
const literal = (value: unknown): string => (typeof value === 'string' ? value : '');

const renderElement = (element: Element, key: number, budget: { count: number }): React.ReactNode => {
  if (!element || typeof element !== 'object') return null;
  budget.count += 1;
  if (budget.count > 16) return null;
  switch (element.type) {
    case 'Stack':
      return <div className="v2-gig__stack" key={key}>{Array.isArray(element.children)
        ? element.children.map((child: Element, index: number) => renderElement(child, index, budget)) : null}</div>;
    case 'Text': return <TextView key={key} body={literal(element.text)} />;
    case 'Badge': return <BadgeView key={key} label={literal(element.text)} />;
    case 'KeyValue': return <KeyValueView key={key} pairs={[{ key: literal(element.label), value: literal(element.value) }]} />;
    case 'List': return <ListView key={key} items={Array.isArray(element.rows) ? element.rows.slice(0, 10).map(literal) : []} />;
    case 'Link': {
      const href = safeGithubLink(element.href);
      return href ? <CardLink key={key} url={href} label={literal(element.text)} showHost={false} /> : null;
    }
    default: return null;
  }
};

const V2GigCard: React.FC<{ message: V2Message; time?: string }> = ({ message, time }) => {
  const payload = message.payload;
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  if (new Blob([JSON.stringify(payload || {})]).size > 32 * 1024) return null;
  const budget = { count: 0 };
  return <div className="v2-msg v2-msg--system v2-msg--card v2-ui-card" data-testid="gig-card">
    <div className="v2-gig">
      <div className="v2-gig__head"><span>GitHub activity</span>{time && <time>{time}</time>}</div>
      {elements.map((element, index) => renderElement(element as Element, index, budget))}
    </div>
  </div>;
};

export default V2GigCard;
