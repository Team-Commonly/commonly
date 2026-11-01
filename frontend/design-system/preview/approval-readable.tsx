import React from 'react';
import axios from 'axios';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../../src/context/AuthContext';
import i18n, { i18nReady } from '../../src/i18n';
import V2ApprovalCard from '../../src/v2/components/V2ApprovalCard';
import '../../src/v2/v2.css';
// The approval card's rules live in the chat sheets V2App loads (S3).
import '../../src/v2/chat/chat-message.css';
import '../../src/v2/chat/chat-states.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/500.css';

// Preview-only: answer the owner's pending-approvals read with fixture calls,
// so the specimen renders the verb, rows and exact arguments without a server.
const PENDING = { approvals: [
  { approvalId: 'merge', messageId: 'merge', toolCall: { tool: 'github.merge_pull_request', canonicalArgs: {
    owner: 'Team-Commonly', repo: 'demo-day', pullNumber: 4, mergeMethod: 'squash',
    headSha: 'abc1234def5678abc1234def5678abc1234def56' } } },
  { approvalId: 'inherited', messageId: 'inherited', toolCall: { tool: 'linear.create_issue', canonicalArgs: {
    teamId: 'ENG', title: 'Approval rows wrap instead of widening the card on a phone',
    description: 'Seen on a 390px screen.\nThe exact arguments stay one click away.', labels: ['ux', 'p1'], toString: 'own key' } } },
] };
axios.interceptors.request.use((config) => (String(config.url || '').startsWith('/api/approvals/pending')
  ? { ...config, adapter: async (c) => ({ data: PENDING, status: 200, statusText: 'OK', headers: {}, config: c }) }
  : config));

async function show() {
  await i18nReady;
  await i18n.changeLanguage(new URLSearchParams(window.location.search).get('lang') || 'en');
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
