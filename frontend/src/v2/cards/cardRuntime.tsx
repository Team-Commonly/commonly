import React from 'react';
import { createLibrary, defineComponent, Renderer } from '@openuidev/react-lang';
import { z } from 'zod/v4';
import type { LibraryJSONSchema } from '@openuidev/lang-core';
import catalogue from './uiCardCatalogue.json';
import { BadgeView, CardLink, DiffView, KeyValueView, ListView, StepsView, TableView, TaskView, TextView, TraceView } from './cardViews';
import type { Node } from './cardViews';

const views: Record<string, (p: Record<string, any>, render: (v: unknown) => React.ReactNode) => React.ReactNode> = {
  Card: (p, render) => {
    const links = p.children.filter((n: Node) => n.typeName === 'Link' && n.props.as !== 'text');
    const body = p.children.filter((n: Node) => !links.includes(n));
    return <section className="ui"><div className="ui-h"><h4>{p.title}</h4>{p.meta && <span className="ui-meta">{p.meta}</span>}</div>
      {p.summary && <p className="ui-sum">{p.summary}</p>}<div className="ui-bd">{body.map((n: Node, i: number) => <React.Fragment key={i}>{render(n)}</React.Fragment>)}</div>
      {!!links.length && <div className="ui-ft">{links.map((n: Node, i: number) => <React.Fragment key={i}>{render(n)}</React.Fragment>)}</div>}</section>;
  },
  Text: (p, render) => <TextView body={p.body} render={render} />,
  Badge: p => <BadgeView label={p.label} tone={p.tone} />,
  List: p => <ListView items={p.items} ordered={p.ordered} />,
  Steps: p => <StepsView steps={p.steps} />,
  DiffSummary: p => <DiffView files={p.files} />,
  KeyValue: p => <KeyValueView pairs={p.pairs.map((n: Node) => n.props)} />,
  Table: p => <TableView columns={p.columns} rows={p.rows} />,
  Link: p => <CardLink label={p.label} url={p.url} as={p.as} />,
  TaskStatus: p => <TaskView taskId={p.taskId} note={p.note} />,
  RunTrace: p => <TraceView limit={p.limit} />,
  Step: () => null, File: () => null, Pair: () => null, Col: () => null,
};
const components = Object.entries(catalogue.$defs).map(([name, definition]) => defineComponent({
  name, description: name,
  // The canonical JSON supplies the parser grammar, including bounds and refs.
  // These prop slots preserve its wire order; no independently authored schema.
  props: z.object(Object.fromEntries(Object.keys(definition.properties).map(key => [key, z.any()]))),
  component: ({ props, renderNode }) => views[name](props, renderNode),
}));
const base = createLibrary({ components });
const library = { ...base, toJSONSchema: () => catalogue as LibraryJSONSchema };
export default function CardRuntime({ source, onError }: { source: string; onError: () => void }) {
  return <Renderer response={source} library={library} publishObservability={false}
    onError={errors => { if (errors.some(e => e.severity !== 'warning')) onError(); }} />;
}
