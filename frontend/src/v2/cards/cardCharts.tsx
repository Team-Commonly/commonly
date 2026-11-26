import React from 'react';
import type { Node } from './cardViews';
import { literal } from './cardViews';

// Catalogue revision 3. Prop names follow OpenUI's own design-system examples
// (Progress(value, label), BarChart(labels, series, variant, xLabel, yLabel)),
// so a model that learned OpenUI writes cards this catalogue accepts. Drawn in
// v2 tokens: series take accent, ink, secondary and muted in that fixed order.

export function ProgressView({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  const shown = `${Math.round(pct)}%`;
  return <div className="ui-pg">
    <div className="ui-pg-h">{label ? <span className="l">{label}</span> : <span />}<span className="n">{shown}</span></div>
    <div className="ui-pg-t" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label || shown}>
      <span style={{ width: `${pct}%` }} />
    </div>
  </div>;
}

interface Series { category: string; values: number[] }
const seriesOf = (nodes: Node[]): Series[] => nodes.map(node => ({
  category: literal(node.props.category),
  values: (node.props.values as unknown[]).map(v => Number(v) || 0),
}));

const W = 480; const H = 180;
const PAD = { l: 36, r: 8, t: 10, b: 24 };
const fmt = (n: number) => (Math.abs(n) >= 1000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n * 10) / 10));

/** One linear scale for marks, ticks and labels. */
function scale(lo: number, hi: number) {
  const low = Math.min(0, lo);
  const high = Math.max(0, hi) === low ? low + 1 : Math.max(0, hi);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - low) / (high - low));
  return { y, ticks: [low, (low + high) / 2, high].filter((v, i, all) => all.indexOf(v) === i) };
}

function Frame({ ticks, y, labels, x, xLabel, yLabel, children }: {
  ticks: number[]; y: (v: number) => number; labels: string[]; x: (i: number) => number;
  xLabel?: string; yLabel?: string; children: React.ReactNode;
}) {
  // A label every few columns once they crowd.
  const every = Math.ceil(labels.length / 8);
  return <svg className="ui-ch-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={[yLabel, xLabel].filter(Boolean).join(' by ') || 'Chart'}>
    {ticks.map(t => <g key={t}><line className="gr" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
      <text className="tk" x={PAD.l - 6} y={y(t)} dy="0.32em" textAnchor="end">{fmt(t)}</text></g>)}
    {/* The marks draw in once, left to right (uiCard.css). */}
    <g className="mk">{children}</g>
    {labels.map((l, i) => (i % every === 0 ? <text key={i} className="tk" x={x(i)} y={H - 6} textAnchor="middle">{l}</text> : null))}
  </svg>;
}

function Legend({ series, xLabel, yLabel }: { series: Series[]; xLabel?: string; yLabel?: string }) {
  return <div className="ui-ch-lg">
    {series.length > 1 && series.map((s, i) => <span key={i} className={`k c${i + 1}`}><i aria-hidden="true" />{s.category}</span>)}
    {(xLabel || yLabel) && <span className="ax">{[yLabel, xLabel].filter(Boolean).join(' · ')}</span>}
  </div>;
}

/** The numbers behind the marks, for a screen reader and anyone who wants them. */
function DataTable({ labels, series }: { labels: string[]; series: Series[] }) {
  return <table className="ui-ch-data"><thead><tr><th />{series.map((s, i) => <th key={i}>{s.category}</th>)}</tr></thead>
    <tbody>{labels.map((l, r) => <tr key={r}><th>{l}</th>{series.map((s, i) => <td key={i}>{s.values[r]}</td>)}</tr>)}</tbody></table>;
}

export function BarChartView({ labels, series: nodes, variant, xLabel, yLabel }: {
  labels: string[]; series: Node[]; variant?: string; xLabel?: string; yLabel?: string;
}) {
  const series = seriesOf(nodes);
  const stacked = variant === 'stacked' && series.length > 1;
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + Math.max(0, s.values[i]), 0));
  const all = series.flatMap(s => s.values);
  const { y, ticks } = scale(Math.min(...all), stacked ? Math.max(...totals) : Math.max(...all));
  const band = (W - PAD.l - PAD.r) / labels.length;
  const x = (i: number) => PAD.l + band * (i + 0.5);
  const inner = Math.min(band * 0.7, 56);
  const bar = stacked ? inner : inner / series.length;
  return <figure className="ui-ch">
    <Frame ticks={ticks} y={y} labels={labels.map(literal)} x={x} xLabel={xLabel} yLabel={yLabel}>
      {labels.map((label, i) => {
        let base = 0;
        return <g key={i}>{series.map((s, j) => {
          const v = s.values[i];
          const from = stacked ? base : 0;
          const to = stacked ? base + Math.max(0, v) : v;
          if (stacked) base = to;
          const left = x(i) - inner / 2 + (stacked ? 0 : bar * j);
          const top = Math.min(y(from), y(to));
          // A 1px gap between neighbours, so touching fills stay two marks.
          return <rect key={j} className={`c${j + 1}`} x={left + 0.5} y={top} width={Math.max(1, bar - 1)} height={Math.max(0, Math.abs(y(to) - y(from)) - (stacked ? 1 : 0))} rx={1.5}>
            <title>{`${literal(label)} · ${s.category}: ${v}`}</title>
          </rect>;
        })}</g>;
      })}
      <line className="bl" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
    </Frame>
    <Legend series={series} xLabel={xLabel} yLabel={yLabel} />
    <DataTable labels={labels.map(literal)} series={series} />
  </figure>;
}

export function LineChartView({ labels, series: nodes, xLabel, yLabel }: {
  labels: string[]; series: Node[]; xLabel?: string; yLabel?: string;
}) {
  const series = seriesOf(nodes);
  const all = series.flatMap(s => s.values);
  const { y, ticks } = scale(Math.min(...all), Math.max(...all));
  const step = labels.length > 1 ? (W - PAD.l - PAD.r - 16) / (labels.length - 1) : 0;
  const x = (i: number) => (labels.length > 1 ? PAD.l + 8 + step * i : (PAD.l + W - PAD.r) / 2);
  return <figure className="ui-ch">
    <Frame ticks={ticks} y={y} labels={labels.map(literal)} x={x} xLabel={xLabel} yLabel={yLabel}>
      {series.map((s, j) => <g key={j} className={`c${j + 1}`}>
        <polyline className={`ln${j ? ' d' : ''}`} points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
        {s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={3}><title>{`${literal(labels[i])} · ${s.category}: ${v}`}</title></circle>)}
      </g>)}
    </Frame>
    <Legend series={series} xLabel={xLabel} yLabel={yLabel} />
    <DataTable labels={labels.map(literal)} series={series} />
  </figure>;
}
