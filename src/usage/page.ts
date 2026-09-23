export const USAGE_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>AI usage · Burooj</title>
  <link rel="stylesheet" href="/assets/usage.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to usage</a>
  <header class="masthead">
    <div class="wordmark"><span class="signal" aria-hidden="true"></span> usage.burooj.dev</div>
    <div class="privacy"><span aria-hidden="true">●</span> private · transcript-free</div>
  </header>
  <main id="main">
    <section class="intro" aria-labelledby="page-title">
      <p class="eyebrow">PERSONAL AI LEDGER / <span id="as-of">loading</span></p>
      <h1 id="page-title" aria-label="AI usage, in one place">AI usage,<br><em>in one place.</em></h1>
      <p class="lede">A stitched record of coding agents, editor copilots, and web conversations. Exact when a client kept counters; candid when it did not.</p>
    </section>

    <section class="totals" aria-label="Lifetime totals">
      <div class="total total-primary"><span class="label">Recorded tokens</span><strong id="total-tokens">—</strong><small>exact counters only</small></div>
      <div class="total total-cost"><span class="label">List-price equivalent</span><strong id="total-cost">—</strong><small id="cost-coverage">priced exact tokens</small></div>
      <div class="total"><span class="label">Sessions</span><strong id="total-sessions">—</strong><small>captured conversations</small></div>
      <div class="total"><span class="label">Messages</span><strong id="total-messages">—</strong><small>where countable</small></div>
      <div class="total"><span class="label">Projects</span><strong id="total-projects">—</strong><small>attributed workspaces</small></div>
    </section>

    <section class="river" aria-labelledby="river-title">
      <div class="section-head">
        <div><p class="kicker">01 / USAGE RIVER</p><h2 id="river-title">Recorded tokens over time</h2></div>
        <div class="ranges" role="group" aria-label="Time range">
          <button type="button" data-range="90">90D</button>
          <button type="button" data-range="365">1Y</button>
          <button type="button" data-range="all" class="active" aria-pressed="true">ALL</button>
        </div>
      </div>
      <div id="chart" class="chart" role="img" aria-label="Recorded token usage over time"></div>
      <div id="source-filters" class="source-filters" aria-label="Filter sources"></div>
    </section>

    <section class="projects" aria-labelledby="projects-title">
      <div class="section-head">
        <div><p class="kicker">02 / PROJECT MAP</p><h2 id="projects-title">Where the work went</h2></div>
        <p class="section-note">Tokens rank exact sources. Session-only tools remain visible.</p>
      </div>
      <div id="project-list" class="project-list"></div>
    </section>

    <section class="coverage" aria-labelledby="coverage-title">
      <div class="section-head">
        <div><p class="kicker">03 / COVERAGE</p><h2 id="coverage-title">What the record knows</h2></div>
        <p class="section-note">Dollar figures use current standard list prices for models with exact counters. They are not subscription spend. No prompt or response text is copied.</p>
      </div>
      <div id="coverage-list" class="coverage-list"></div>
    </section>
  </main>
  <footer><span>local-first usage index · auto-refresh 15m</span><span id="devices">—</span></footer>
  <div id="error" class="error" role="alert" hidden></div>
  <script src="/assets/usage.js" defer></script>
</body>
</html>`;

export const USAGE_CSS = `
:root{--ink:#17231d;--muted:#68736c;--paper:#f0eee6;--paper-2:#e7e3d7;--line:#c8c5b9;--acid:#b7ee42;--rust:#d65f3e;--blue:#4b7fd6;--gold:#c79b39;--white:#fbfaf6;--shadow:rgba(23,35,29,.12)}
*{box-sizing:border-box}html{background:var(--paper);color:var(--ink);font-family:"Avenir Next","Gill Sans",sans-serif}body{margin:0;background:radial-gradient(circle at 76% 2%,rgba(183,238,66,.22),transparent 24rem),linear-gradient(rgba(23,35,29,.035) 1px,transparent 1px);background-size:auto,100% 32px;min-height:100vh}.skip-link{position:fixed;left:1rem;top:-5rem;background:var(--ink);color:white;padding:.7rem 1rem;z-index:10}.skip-link:focus{top:1rem}.masthead,footer{display:flex;justify-content:space-between;align-items:center;padding:1rem clamp(1.2rem,4vw,4rem);border-bottom:1px solid var(--ink);font:700 .72rem/1.2 "SFMono-Regular",Menlo,monospace;letter-spacing:.06em;text-transform:uppercase}.signal{display:inline-block;width:.65rem;height:.65rem;background:var(--acid);border:1px solid var(--ink);border-radius:50%;box-shadow:0 0 0 .25rem rgba(183,238,66,.25);margin-right:.6rem}.privacy{color:var(--muted)}.privacy span{color:var(--acid);text-shadow:0 0 0 1px var(--ink)}main{max-width:1440px;margin:0 auto;padding:clamp(2rem,6vw,6rem) clamp(1.2rem,4vw,4rem) 5rem}.intro{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(18rem,.6fr);gap:3rem;align-items:end;padding-bottom:clamp(3rem,7vw,7rem)}.eyebrow,.kicker,.label{font:700 .7rem/1.3 "SFMono-Regular",Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}.eyebrow{grid-column:1/-1;margin:0;color:var(--muted)}h1{font:500 clamp(4rem,11vw,10rem)/.77 "Iowan Old Style","Palatino Linotype",serif;letter-spacing:-.07em;margin:0;max-width:11ch}h1 em{font-weight:400;color:var(--rust)}.lede{font:400 clamp(1.05rem,1.8vw,1.4rem)/1.55 "Iowan Old Style","Palatino Linotype",serif;margin:0 0 .45rem;max-width:32rem}.totals{display:grid;grid-template-columns:1.5fr 1.2fr repeat(3,1fr);border:1px solid var(--ink);background:rgba(251,250,246,.7);box-shadow:10px 10px 0 var(--shadow)}.total{min-height:9.5rem;padding:1.25rem;display:flex;flex-direction:column;justify-content:space-between;border-left:1px solid var(--ink)}.total:first-child{border-left:0}.total-primary{background:var(--ink);color:var(--white)}.total-cost{background:var(--acid)}.total strong{font:500 clamp(2.25rem,4.4vw,5rem)/1 "Iowan Old Style","Palatino Linotype",serif;letter-spacing:-.055em}.total small{font:.72rem/1.3 "SFMono-Regular",Menlo,monospace;color:var(--muted)}.total-primary small{color:#b7c3bc}.river,.projects,.coverage{padding-top:clamp(4rem,8vw,8rem)}.section-head{display:flex;justify-content:space-between;align-items:end;gap:2rem;padding-bottom:1.2rem;border-bottom:1px solid var(--ink)}.kicker{margin:0 0 .55rem;color:var(--rust)}h2{font:500 clamp(2rem,4vw,4.3rem)/.95 "Iowan Old Style","Palatino Linotype",serif;letter-spacing:-.045em;margin:0}.section-note{max-width:31rem;color:var(--muted);font:.82rem/1.5 "SFMono-Regular",Menlo,monospace;margin:0}.ranges{display:flex;border:1px solid var(--ink)}button{appearance:none;border:0;border-left:1px solid var(--ink);background:transparent;color:var(--ink);font:700 .72rem/1 "SFMono-Regular",Menlo,monospace;padding:.7rem .85rem;cursor:pointer}button:first-child{border-left:0}button:hover,button:focus-visible{background:var(--paper-2)}button:focus-visible{outline:3px solid var(--blue);outline-offset:2px}button.active{background:var(--ink);color:var(--white)}.chart{height:clamp(18rem,36vw,31rem);padding:2rem 0 1rem;border-bottom:1px solid var(--line)}.chart svg{display:block;width:100%;height:100%;overflow:visible}.chart-grid{stroke:var(--line);stroke-dasharray:2 5}.chart-area{fill:url(#usage-fill)}.chart-line{fill:none;stroke:var(--ink);stroke-width:2.25;vector-effect:non-scaling-stroke}.chart-dot{fill:var(--acid);stroke:var(--ink);stroke-width:1.5}.chart-label{font:10px "SFMono-Regular",Menlo,monospace;fill:var(--muted)}.source-filters{display:flex;flex-wrap:wrap;gap:.55rem;padding-top:1rem}.source-filters button{border:1px solid var(--ink);display:flex;gap:.55rem;align-items:center}.source-filters button::before{content:"";width:.5rem;height:.5rem;border-radius:50%;background:var(--source-color,var(--ink));border:1px solid var(--ink)}.source-filters button.off{opacity:.4;text-decoration:line-through}.project-list{border-bottom:1px solid var(--ink)}.project-row{display:grid;grid-template-columns:minmax(11rem,1fr) minmax(10rem,2fr) 8rem 7rem;gap:1.5rem;align-items:center;padding:1.15rem 0;border-top:1px solid var(--line)}.project-row:first-child{border-top:0}.project-name{font:600 1rem/1.2 "Avenir Next","Gill Sans",sans-serif;overflow:hidden;text-overflow:ellipsis}.project-bar{height:.75rem;background:var(--paper-2);position:relative;border-left:1px solid var(--ink)}.project-bar span{display:block;height:100%;background:var(--ink);min-width:2px}.project-metric{font:600 .76rem/1.3 "SFMono-Regular",Menlo,monospace;text-align:right}.project-sessions{color:var(--muted)}.coverage-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-left:1px solid var(--ink);border-top:1px solid var(--ink)}.coverage-item{padding:1.35rem;border-right:1px solid var(--ink);border-bottom:1px solid var(--ink);background:rgba(251,250,246,.55)}.coverage-item header{display:flex;justify-content:space-between;gap:1rem;align-items:center}.coverage-item h3{font:700 1rem/1.2 "SFMono-Regular",Menlo,monospace;margin:0}.status{font:700 .64rem/1 "SFMono-Regular",Menlo,monospace;text-transform:uppercase;padding:.35rem .5rem;border:1px solid var(--ink)}.status-exact{background:var(--acid)}.status-partial{background:#f0c86f}.status-count-only{background:#c8d9f5}.status-missing{background:#e5b4a8}.coverage-item p{color:var(--muted);margin:.9rem 0 0;font:.87rem/1.5 "SFMono-Regular",Menlo,monospace}.coverage-item small{display:block;margin-top:.8rem;color:var(--rust);font:.7rem/1.2 "SFMono-Regular",Menlo,monospace}footer{border-top:1px solid var(--ink);border-bottom:0;color:var(--muted)}.error{position:fixed;inset:auto 1rem 1rem;background:var(--rust);color:white;border:1px solid var(--ink);padding:1rem;font:700 .85rem/1.4 "SFMono-Regular",Menlo,monospace}.empty{padding:4rem 0;color:var(--muted);font:1rem/1.5 "SFMono-Regular",Menlo,monospace}
@media(max-width:760px){.intro{grid-template-columns:1fr;gap:1.5rem}.eyebrow{grid-column:auto}h1{font-size:clamp(3.7rem,18vw,6.5rem)}.totals{grid-template-columns:1fr 1fr}.total{border-top:1px solid var(--ink);border-left:1px solid var(--ink)}.total:nth-child(-n+2){border-top:0}.total:nth-child(odd){border-left:0}.total:last-child{grid-column:1/-1;border-left:0}.section-head{align-items:start;flex-direction:column}.project-row{grid-template-columns:minmax(0,1fr) 6.5rem;gap:.55rem 1rem}.project-bar{grid-column:1/-1;grid-row:2}.project-sessions{display:none}.coverage-list{grid-template-columns:1fr}.privacy{display:none}.chart{height:19rem}}
@media(prefers-reduced-motion:no-preference){.total,.coverage-item,.project-row{animation:rise .5s both}@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}
`;

export const USAGE_JS = String.raw`
const $ = (id) => document.getElementById(id);
const colors = {'codex':'#17231d','claude-code':'#d65f3e','cursor':'#4b7fd6','github-copilot':'#7356a8','gemini-cli':'#c79b39','antigravity':'#4b9b79','chatgpt':'#56a684','claude-web':'#d88767','gemini-web':'#6e91d3'};
const sourceName = (source) => ({'codex':'Codex','claude-code':'Claude Code','cursor':'Cursor','github-copilot':'GitHub Copilot','gemini-cli':'Gemini CLI','antigravity':'Antigravity','chatgpt':'ChatGPT','claude-web':'Claude web','gemini-web':'Gemini web'}[source] || source);
const format = (n) => new Intl.NumberFormat('en-US',{notation:n>=100000?'compact':'standard',maximumFractionDigits:n>=100000?1:0}).format(n || 0);
const exact = (n) => new Intl.NumberFormat('en-US').format(n || 0);
const dollars = (n) => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:n>=10000?'compact':'standard',maximumFractionDigits:n>=10000?1:0}).format(n || 0);
const esc = (v) => String(v).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let snapshot = null; let range = 'all'; const disabled = new Set();
function visible(){ const cutoff=range==='all'?null:new Date(Date.now()-Number(range)*86400000).toISOString().slice(0,10); return snapshot.buckets.filter(b=>(!cutoff||b.date>=cutoff)&&!disabled.has(b.source)); }
function totals(rows){ return rows.reduce((a,b)=>{a.tokens+=b.totalTokens;a.sessions+=b.sessions;a.messages+=b.messages;if(b.estimatedUsd!==null&&b.estimatedUsd!==undefined){a.cost+=b.estimatedUsd;a.priced+=b.totalTokens}if(b.project!=='Unattributed'&&b.project!=='General chat')a.projects.add(b.project);return a},{tokens:0,sessions:0,messages:0,cost:0,priced:0,projects:new Set()}); }
function renderTotals(rows){const t=totals(rows);$('total-tokens').textContent=format(t.tokens);$('total-cost').textContent=dollars(t.cost);$('cost-coverage').textContent=(t.tokens?Math.round(t.priced/t.tokens*100):0)+'% of exact tokens priced';$('total-sessions').textContent=exact(t.sessions);$('total-messages').textContent=format(t.messages);$('total-projects').textContent=exact(t.projects.size);}
function periodKey(day,monthly){return monthly?day.slice(0,7):day;}
function renderChart(rows){const dated=rows.filter(b=>/^\d{4}-\d{2}-\d{2}$/.test(b.date));const days=[...new Set(dated.map(b=>b.date))].sort();const monthly=days.length>180;const map=new Map();dated.forEach(b=>{const k=periodKey(b.date,monthly);map.set(k,(map.get(k)||0)+b.totalTokens)});const values=[...map].sort(([a],[b])=>a.localeCompare(b));if(!values.length||values.every(([,v])=>v===0)){$('chart').innerHTML='<p class="empty">Token history is not available for the selected sources. Their session counts remain in the project map.</p>';return;}const W=1200,H=360,p={l:12,r:12,t:16,b:32},max=Math.max(...values.map(v=>v[1]),1);const x=(i)=>p.l+(values.length===1?0:i/(values.length-1))*(W-p.l-p.r);const y=(v)=>p.t+(1-v/max)*(H-p.t-p.b);const pts=values.map((v,i)=>[x(i),y(v[1])]);const line=pts.map((q,i)=>(i?'L':'M')+q[0].toFixed(1)+' '+q[1].toFixed(1)).join(' ');const area=line+' L '+x(values.length-1)+' '+(H-p.b)+' L '+x(0)+' '+(H-p.b)+' Z';const labels=[0,Math.floor((values.length-1)/2),values.length-1].filter((v,i,a)=>a.indexOf(v)===i);$('chart').innerHTML='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b7ee42" stop-opacity=".78"/><stop offset="1" stop-color="#b7ee42" stop-opacity=".04"/></linearGradient></defs>'+[.25,.5,.75].map(v=>'<line class="chart-grid" x1="0" x2="'+W+'" y1="'+y(max*v)+'" y2="'+y(max*v)+'"/>').join('')+'<path class="chart-area" d="'+area+'"/><path class="chart-line" d="'+line+'"/>'+pts.map((q,i)=>i===pts.length-1?'<circle class="chart-dot" cx="'+q[0]+'" cy="'+q[1]+'" r="5"/>':'').join('')+labels.map(i=>'<text class="chart-label" x="'+x(i)+'" y="'+(H-7)+'" text-anchor="'+(i===0?'start':i===values.length-1?'end':'middle')+'">'+esc(values[i][0])+'</text>').join('')+'<text class="chart-label" x="'+(W-4)+'" y="12" text-anchor="end">peak '+esc(format(max))+'</text></svg>';}
function renderProjects(rows){const map=new Map();rows.forEach(b=>{const item=map.get(b.project)||{tokens:0,sessions:0,messages:0};item.tokens+=b.totalTokens;item.sessions+=b.sessions;item.messages+=b.messages;map.set(b.project,item)});const items=[...map].sort((a,b)=>b[1].tokens-a[1].tokens||b[1].sessions-a[1].sessions).slice(0,24);const max=Math.max(...items.map(i=>i[1].tokens),1);$('project-list').innerHTML=items.length?items.map(([name,v])=>'<div class="project-row"><div class="project-name" title="'+esc(name)+'">'+esc(name)+'</div><div class="project-bar" aria-label="'+esc(name)+' '+exact(v.tokens)+' recorded tokens"><span style="width:'+Math.max(1,v.tokens/max*100)+'%"></span></div><div class="project-metric">'+(v.tokens?format(v.tokens):'—')+' tok</div><div class="project-metric project-sessions">'+exact(v.sessions)+' sessions</div></div>').join(''):'<p class="empty">No projects in this range.</p>';}
function renderFilters(){const sources=[...new Set(snapshot.buckets.map(b=>b.source))].sort();$('source-filters').innerHTML=sources.map(s=>'<button type="button" data-source="'+esc(s)+'" style="--source-color:'+(colors[s]||'#17231d')+'" aria-pressed="'+(!disabled.has(s))+'" class="'+(disabled.has(s)?'off':'')+'">'+esc(sourceName(s))+'</button>').join('');document.querySelectorAll('[data-source]').forEach(btn=>btn.addEventListener('click',()=>{const s=btn.dataset.source;disabled.has(s)?disabled.delete(s):disabled.add(s);render();}));}
function renderCoverage(){const rank={exact:0,partial:1,'count-only':2,missing:3};const rows=[...snapshot.coverage].sort((a,b)=>(rank[a.status]-rank[b.status])||a.source.localeCompare(b.source));$('coverage-list').innerHTML=rows.map(c=>'<article class="coverage-item"><header><h3>'+esc(sourceName(c.source))+'</h3><span class="status status-'+esc(c.status)+'">'+esc(c.status.replace('-',' '))+'</span></header><p>'+esc(c.detail)+'</p><small>'+exact(c.records)+' records found</small></article>').join('');}
function render(){const rows=visible();renderTotals(rows);renderChart(rows);renderProjects(rows);renderFilters();}
document.querySelectorAll('[data-range]').forEach(btn=>btn.addEventListener('click',()=>{range=btn.dataset.range;document.querySelectorAll('[data-range]').forEach(b=>{const active=b===btn;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active))});render();}));
async function load(){try{const r=await fetch('/api/usage',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw new Error('usage API returned '+r.status);const data=await r.json();const changed=!snapshot||snapshot.generatedAt!==data.generatedAt;snapshot=data;$('as-of').textContent=new Date(data.generatedAt).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});$('devices').textContent=(data.devices||[]).join(' + ')||'no devices';$('error').hidden=true;if(changed){renderCoverage();render();}}catch(err){$('error').hidden=false;$('error').textContent='Could not load the usage ledger: '+err.message;}}
load();setInterval(load,60000);
`;
