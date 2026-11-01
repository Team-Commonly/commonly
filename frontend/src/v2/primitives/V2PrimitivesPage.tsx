import React from 'react';
import './primitives.css';

// TASK-730 (D223): the shared primitives rendered alone, so a surface can be
// checked against the artboard frame without the shell around it. Served at
// /v2/_primitives. Light and dark follow the page's data-v2-theme, the same as
// every other v2 surface.
const V2PrimitivesPage: React.FC = () => (
  <div className="v2p-root" data-testid="v2p-root">
    <div className="v2p-sh v2p-sh--page" style={{ height: '100vh' }}>
      <div aria-hidden="true" />
      <section className="v2p-pane" aria-label="Primitives">
        <header className="v2p-ph">
          <h1>Primitives</h1>
          <span className="meta">D223 · TASK-730</span>
          <span className="sp" />
          <div className="v2p-seg" role="group" aria-label="View">
            <button type="button" className="on">Light</button>
            <button type="button">Dark</button>
          </div>
        </header>

        <div className="v2p-body">
          <div className="v2p-gtitle">buttons</div>
          <div className="v2p-list">
            <div className="v2p-lrow">
              <div className="lb">Keys</div>
              <div className="vl">
                <button type="button" className="v2p-b v2p-b-p">Primary</button>
                <button type="button" className="v2p-b v2p-b-c">Cobalt</button>
                <button type="button" className="v2p-b v2p-b-s">Secondary</button>
                <button type="button" className="v2p-b v2p-b-g">Ghost</button>
                <button type="button" className="v2p-b v2p-b-s v2p-b-sm">Small</button>
                <button type="button" className="v2p-b v2p-b-s v2p-ib" aria-label="Icon">+</button>
              </div>
              <div className="ac" />
            </div>
          </div>

          <div className="v2p-gtitle">chips, badges, dots</div>
          <div className="v2p-list">
            <div className="v2p-lrow">
              <div className="lb">Tags</div>
              <div className="vl">
                <span className="v2p-chip">pod</span>
                <span className="v2p-chip on">selected</span>
                <span className="v2p-badge">3</span>
                <span className="v2p-dot" aria-label="active" />
                <span className="v2p-dot v2p-dot--idle" aria-label="idle" />
                <span className="v2p-dot v2p-dot--off" aria-label="off" />
                <span className="v2p-tg on" aria-label="on" />
              </div>
              <div className="ac" />
            </div>
          </div>

          <div className="v2p-gtitle">card</div>
          <div className="v2p-tc">
            <div className="top1"><span>task-730</span><span className="sp" /><span>P0</span></div>
            <div className="tt">Build the shared primitives from the artboard frame</div>
          </div>
        </div>

        <aside className="v2p-drawer" aria-label="Drawer example">
          <div className="dh"><span className="v2p-chip">drawer</span></div>
          <div className="db">
            <h2>Drawer title</h2>
            <p className="v2p-body" style={{ padding: 0 }}>The drawer sits over the pane at 400px.</p>
          </div>
        </aside>
      </section>
    </div>
  </div>
);

export default V2PrimitivesPage;
