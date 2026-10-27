import revision from '../../src/v2/cards/uiCardCatalogueRevision.json';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SocketProvider } from '../../src/context/SocketContext';
import { AuthContext } from '../../src/context/AuthContext';
import V2UICard from '../../src/v2/cards/V2UICard';
import '../../src/v2/v2.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/500.css';
const sources = [
 'root = Card("Release assessment", [Text("The change preserves identity and existing grants."), Steps([Step("Read the patch", "done"), Step("Check the release", "active", "CI is running"), Step("Publish", "pending")]), DiffSummary([File("frontend/src/v2/cards/V2UICard.tsx", 84, 12), File("backend/config/uiCardCatalogue.json", 30, 2)]), Link("Open pull request", "https://github.com/Team-Commonly/commonly/pull/2675", "primary")], "4 minutes ago", "The catalogue uses the same Signal tokens as the shell.")',
 'root = Card("Project state", [TaskStatus("TASK-498", "Agent note: ready for review"), KeyValue([Pair("Repository", "Team-Commonly/commonly"), Pair("Tests", 71)]), Badge("Review pending", "pending"), List(["The component API is fixed", "The trace persists"], true)])',
 'root = Card("Verification", [Table([Col("Surface"), Col("Width", "number"), Col("Result")], [["Pod chat", 1440, "Ready"], ["Pod chat", 390, "Ready"]]), RunTrace(3)])',
 'root = Card("Links", [Text(["Source: ", Link("GitHub", "https://github.com/Team-Commonly/commonly", "text")]), Link("Unapproved host", "https://github.com.evil.test/", "button"), Badge("Done", "done")])',
 'root = Text(@Run("unsafe"))',
];
const auth = { token:null, currentUser:null, user:null, loading:false, error:null, isAuthenticated:false } as any;
createRoot(document.getElementById('root')!).render(<AuthContext.Provider value={auth}><SocketProvider><MemoryRouter><div className="v2-root" style={{height:'auto',minHeight:'100vh',padding:16,boxSizing:'border-box'}}><main style={{maxWidth:560,margin:'0 auto',display:'grid',gap:24}}>{sources.map((source, i) => <V2UICard key={i} authorLabel="Polish" time="now" message={{id:String(i),pod_id:'111111111111111111111111',user_id:'u1',message_type:'card',created_at:new Date().toISOString(),content:'Plain text fallback remains readable.',payload:{...revision,kind:'ui',v:1,lang:'openui@1',source,runId:'012345678901234567890123'}}} />)}<V2UICard authorLabel="Polish" time="31d" message={{id:'old',pod_id:'111111111111111111111111',user_id:'u1',message_type:'card',created_at:new Date(Date.now()-31*86400000).toISOString(),content:'Expired card content.',payload:{...revision,kind:'ui',v:1,lang:'openui@1',source:'root = Text("Old")',runId:'012345678901234567890123'}}} /><V2UICard authorLabel="Polish" message={{id:"unsupported",pod_id:"111111111111111111111111",user_id:"u1",message_type:"card",created_at:new Date().toISOString(),content:"Unsupported revision keeps this text.",payload:{...revision,catalogRev:2,kind:"ui",v:1,lang:"openui@1",source:'root = Text("Do not guess")'}}} /></main></div></MemoryRouter></SocketProvider></AuthContext.Provider>);
