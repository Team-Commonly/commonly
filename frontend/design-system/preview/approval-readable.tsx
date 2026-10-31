import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../../src/context/AuthContext';
import i18n, { i18nReady } from '../../src/i18n';
import V2ApprovalCard from '../../src/v2/components/V2ApprovalCard';
import '../../src/v2/v2.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/500.css';

async function show() {
  await i18nReady;
  await i18n.changeLanguage(new URLSearchParams(location.search).get('lang') || 'en');
  createRoot(document.getElementById('root')!).render(
    <AuthContext.Provider value={{currentUser:{_id:'viewer-1'},token:null} as never}>
      <MemoryRouter><div className="v2-root" style={{height:'auto',minHeight:'100vh',padding:16,boxSizing:'border-box'}}>
        <main style={{maxWidth:560,margin:'0 auto',display:'grid',gap:24}}>
          {['merge','inherited'].map(id => <V2ApprovalCard key={id} authorLabel="Scout" time="now" message={{
            id, pod_id:'pod-1', content:'Fixture approval', payload:{kind:'approval-card',approvalId:id,status:'flagged',ownerUserId:'viewer-1',actionType:'tool_call'},
          } as never} />)}
        </main>
      </div></MemoryRouter>
    </AuthContext.Provider>,
  );
}
void show();
