import React from 'react';

// TASK-730 (D223): the d215 Settings frame (#s-settings) rebuilt from the
// shared primitives alone. Same groups, rows and order as the artboard; the
// values are fixtures, so the structural diff is what this proves.
const seg = (items: string[], on: string, label: string) => (
  <div className="v2p-seg v2p-seg--sm" role="group" aria-label={label}>
    {items.map((t) => (
      <button key={t} type="button" className={t === on ? 'on' : undefined}>{t}</button>
    ))}
  </div>
);

const V2SettingsFrame: React.FC = () => (
  <div data-testid="v2p-settings-frame" style={{ maxWidth: 760, margin: '0 auto' }}>
    <div className="v2p-gtitle">Account</div>
    <div className="v2p-list">
      <div className="v2p-lrow" style={{ minHeight: 64 }}>
        <div className="lb">alex-kim</div>
        <div className="vl"><span className="mo">@alex-kim · member</span></div>
        <div className="ac">
          <button type="button" className="v2p-b v2p-b-g v2p-b-sm v2p-ib" aria-label="Edit name and username">✎</button>
        </div>
      </div>
      <div className="v2p-lrow">
        <div className="lb">Email</div>
        <div className="vl"><span className="mo">[email]</span></div>
        <div className="ac">
          <button type="button" className="v2p-b v2p-b-g v2p-b-sm v2p-ib" aria-label="Change email">✎</button>
        </div>
      </div>
      <div className="v2p-lrow">
        <div className="lb">Plan</div>
        <div className="vl">Pro<span className="mo">$12 a month</span></div>
        <div className="ac"><button type="button" className="v2p-b v2p-b-g v2p-b-sm">Billing</button></div>
      </div>
    </div>

    <div className="v2p-gtitle">Access</div>
    <div className="v2p-list">
      <details className="v2p-disc">
        <summary>
          <span className="lb">Devices</span>
          <span className="vl">1 CLI device<span className="mo">used 1:21 AM</span></span>
          <svg className="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </summary>
        <div className="v2p-body">alex-laptop · last used 1:21 AM</div>
      </details>
      <div className="v2p-lrow">
        <div className="lb">API token</div>
        <div className="vl"><span className="mo">None</span></div>
        <div className="ac"><button type="button" className="v2p-b v2p-b-s v2p-b-sm">Generate</button></div>
      </div>
      <div className="v2p-lrow">
        <div className="lb">Connectors</div>
        <div className="vl"><span className="mo">0 connected</span></div>
        <div className="ac">
          <button type="button" className="v2p-b v2p-b-g v2p-b-sm v2p-ib" aria-label="Open Connectors">›</button>
        </div>
      </div>
    </div>

    <div className="v2p-gtitle">Look</div>
    <div className="v2p-list">
      <div className="v2p-lrow">
        <div className="lb">Language</div>
        <div className="vl" />
        <div className="ac">{seg(['EN', '中文'], 'EN', 'Language')}</div>
      </div>
      <div className="v2p-lrow">
        <div className="lb">Theme</div>
        <div className="vl" />
        <div className="ac">{seg(['Auto', 'Light', 'Dark'], 'Auto', 'Theme')}</div>
      </div>
    </div>
  </div>
);

export default V2SettingsFrame;
