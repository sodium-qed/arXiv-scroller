import {CATEGORIES} from './categories.js';
import {parseListing,parseAbstract,findPaperNodes,readerTarget} from './parser.js';
import {loadCompleteListing} from './network.js';
import {trainModel,activeFeedback,analytics,subscriptionMatches} from './recommender.js';
import {generateSelection,replaceSelectionPaper} from './sampling.js';
import {makeId,PublicCache} from './storage.js';
import {AIClient} from './ai.js';
import {element,link,field,select,checkbox,richText,STYLES,safeURL} from './dom.js';
import {feedbackCSV,readingCSV,bookmarksBibtex,downloadText} from './exports.js';
import {gmRequest} from './transport.js';
import {mathFragment} from './math.js';

const MODES=[['random','Pure Random'],['balanced','Balanced Exploration'],['personalized','Personalized'],['discovery','Discovery'],['subscriptions','Subscriptions']];
const LEVELS=['Unfamiliar','Introduced','Developing','Comfortable','Proficient','Advanced'];
const REASONS=['','Interesting mathematical problem','Interesting mathematical technique','Interesting application','Interesting author','Uninteresting topic','Excessively technical presentation','Insufficient mathematical background'];
const isoNow=()=>new Date().toISOString();
const fmtDate=value=>value?String(value).slice(0,10):'Unknown date';
const percent=n=>Number.isFinite(n)?`${Math.round(n*100)}%`:'—';

export class DiscoveryApp {
  constructor(store) {
    this.store=store;this.state=null;this.hosts=[];this.roots=[];this.cache=new PublicCache();this.currentPanel=null;
    this.listing=null;this.article=null;this.paperNodes=new Map();this.currentPaper=null;this.activeSelection=null;
    this.selectionHandler=e=>this.handleSelection(e);this.keyHandler=e=>this.handleKeys(e);
  }
  async initialize() {
    this.state=await this.store.initialize();
    this.listing=document.querySelector('#dlpage')?parseListing(document,location.href):null;
    this.article=this.listing?null:parseAbstract(document,location.href);
    this.paperNodes=findPaperNodes(document,location.href);
    const papers=this.listing?.papers||[this.article].filter(Boolean);
    for(const paper of papers) {
      // Standalone metadata must not overwrite the known announcement cycle.
      const previous=this.state.papers[paper.id];
      if(previous&&!paper.announcementDate) paper.announcementDate=previous.announcementDate;
      if(previous&&!paper.section) paper.section=previous.section;
      this.state.papers[paper.id]={...previous,...paper};
    }
    try{await this.store.cachePapers(papers.map(p=>this.state.papers[p.id]));}
    catch{this.state.storageWarnings=[...(this.state.storageWarnings||[]),'Some public paper metadata could not be cached. The original page is unchanged; saving an unusually large or malformed record may fail.'];}
    this.retrain();
    this.ai=new AIClient({request:gmRequest,getSettings:()=>this.state.settings,getKnowledge:()=>this.state.knowledge,getGeneration:()=>this.store.generation(),
      cacheGet:key=>this.store.get('explanations',key),
      cacheSet:async(key,value,generation)=>{if(!await this.store.setIfGeneration('explanations',key,value,generation))throw new Error('Personal data changed during generation; the answer was not saved.');this.state.explanations[key]=value;}});
    this.store.subscribe(()=>this.refreshExternal());
    if(typeof GM_registerMenuCommand==='function') {
      GM_registerMenuCommand('Show arXiv Discovery',()=>this.show().catch(e=>console.error(e)));
      GM_registerMenuCommand('Pair local AI bridge',()=>this.pairBridge().catch(e=>console.error(e)));
    }
    if(this.state.settings.mode!=='original') await this.mount();
  }
  retrain() {this.model=trainModel(this.state.events,this.state.settings);}
  async reload() {
    this.state=await this.store.load();
    // Current-page public metadata stays usable after erasure, without silently
    // recreating a deleted persistent collection. A later explicit save records it.
    for(const paper of this.listing?.papers||[this.article].filter(Boolean))if(!this.state.papers[paper.id])this.state.papers[paper.id]=paper;
    this.retrain();this.updateStatus();
    for(const root of this.roots)for(const row of root.querySelectorAll('.actions[data-paper-id]')){const paper=this.state.papers[row.dataset.paperId];if(paper)row.replaceWith(this.paperActions(paper,row._entry));else row.remove();}
  }
  async rememberPaper(paper) {await this.store.cachePapers([paper]);this.state.papers[paper.id]=paper;}
  async refreshExternal() {
    this.closePanel();this.activeSelection=null;await this.reload();
    if(this.toolbar)this.notify('Changes from another arXiv tab have been loaded. Reopen a panel to view current data.');
  }
  rootHost(id,parent,before=null) {
    const host=element('div',{id,'data-arxiv-discovery':'true','data-theme':this.state.settings.theme});
    const root=host.attachShadow({mode:'closed'});root.append(element('style',{},STYLES));
    parent.insertBefore(host,before);this.hosts.push(host);this.roots.push(root);
    root.addEventListener('mouseup',e=>this.handleSelection(e));return {host,root};
  }
  async mount() {
    if(this.toolbar) return;
    const target=document.querySelector('#dlpage')||document.querySelector('#content-inner')||document.querySelector('main')||document.body;
    const after=target.querySelector('h1');
    const {host,root}=this.rootHost('arxiv-discovery-toolbar',target,after?.parentNode===target?after.nextSibling:target.firstChild);
    this.toolbar=host;this.root=root;
    this.status=element('div',{class:'status',role:'status','aria-live':'polite'});
    const bar=element('nav',{class:'toolbar','aria-label':'arXiv Discovery'},element('span',{class:'brand'},'arXiv Discovery'),
      this.button('Daily selection',()=>this.openDaily()),this.button('Bookmarks',()=>this.openBookmarks()),
      this.button('Authors',()=>this.openAuthors()),this.button('Interests',()=>this.openInterests()),
      this.button('Knowledge',()=>this.openKnowledge()),this.button('Settings',()=>this.openSettings()),
      this.button('Original arXiv',()=>this.hide()),this.status);
    root.append(bar);
    if(this.state.settings.showTools) this.attachPaperTools();
    document.addEventListener('mouseup',this.selectionHandler);
    document.addEventListener('keydown',this.keyHandler);
    this.updateStatus();
  }
  async show() {if(this.state.settings.mode==='original'){this.state.settings=await this.store.settings({mode:this.state.settings.previousMode||'random'});}await this.mount();}
  async hide() {
    this.state.settings=await this.store.settings({previousMode:this.state.settings.mode,mode:'original'});
    this.closePanel();for(const host of this.hosts) host.remove();this.hosts=[];this.roots=[];this.toolbar=null;
    document.removeEventListener('mouseup',this.selectionHandler);document.removeEventListener('keydown',this.keyHandler);
    // The Tampermonkey menu restores the add-on without leaving any controls in arXiv's interface.
  }
  updateStatus(message='') {
    if(!this.status) return;
    const f=activeFeedback(this.state.events,this.state.settings);
    this.status.textContent=message||`${this.listing?.announcementDate?`Publication: ${this.listing.announcementDate} · `:''}${this.listing?`${this.listing.papers.length} papers ${this.listing.complete?'loaded':'in a partial listing'} · `:''}${f.active.length} active / ${f.excluded.length} excluded interest examples · Local-first; AI runs only on request.`;
    for(const host of this.hosts) host.setAttribute('data-theme',this.state.settings.theme);
  }
  notify(text) {this.updateStatus(text);if(this.panelNotice){this.panelNotice.textContent=text;this.panelNotice.hidden=false;}}
  button(text,callback,attrs={}) {
    return element('button',{type:'button',...attrs,onclick:async e=>{if(!e.isTrusted)return;const b=e.currentTarget;b.disabled=true;try{await callback(e);}catch(error){this.notify(error.message||String(error));}finally{if(b.isConnected)b.disabled=false;}}},text);
  }
  closePanel() {this.currentPanel=null;this.progress=null;this.selectionBubble?.remove();this.selectionBubble=null;if(this.dialog){if(this.dialog.open)this.dialog.close();this.dialog.remove();this.dialog=null;this.body=null;this.panelNotice=null;}}
  panel(title,name) {
    this.closePanel();this.currentPanel=name;
    const dialog=element('dialog',{'aria-label':title});
    const close=this.button('Close',()=>this.closePanel(),{'aria-label':`Close ${title}`});
    const body=element('div',{class:'dialog-body'});this.panelNotice=element('p',{role:'status','aria-live':'polite',class:'notice',hidden:true});
    body.append(this.panelNotice);dialog.append(element('header',{class:'dialog-header'},element('h2',{},title),close),body);
    this.root.append(dialog);this.dialog=dialog;this.body=body;
    dialog.addEventListener('cancel',()=>{this.currentPanel=null;});
    dialog.showModal();return body;
  }
  attachPaperTools() {
    for(const [id,nodes] of this.paperNodes) {
      if(!this.state.papers[id]||nodes.dd.querySelector('[data-arxiv-discovery]')) continue;
      const {root}=this.rootHost(`ad-paper-${id.replace(/[^\w-]/g,'-')}`,nodes.dd);
      const detail=element('details',{class:'tools'},element('summary',{},'Discovery tools'));
      detail.addEventListener('toggle',()=>{if(detail.open&&detail.childElementCount===1){const p=this.state.papers[id];detail.append(this.paperActions(p),this.authorControls(p),this.paperProtection(p));}});
      root.append(detail);
    }
    if(this.article&&!this.paperNodes.size) {
      const container=document.querySelector('blockquote.abstract')||document.querySelector('article')||document.querySelector('h1.title');
      if(container){const {root}=this.rootHost('ad-article-tools',container.parentNode,container.nextSibling);root.append(this.paperActions(this.article),this.authorControls(this.article),this.paperProtection(this.article));}
    }
  }
  currentFeedback(paper) {return activeFeedback(this.state.events,this.state.settings).latest.find(e=>e.paperId===paper.id);}
  paperActions(paper,entry=null) {
    const row=element('div',{class:'actions','data-paper-id':paper.id});
    const latest=this.currentFeedback(paper);
    const reason=select(REASONS.map(r=>[r,r||'Optional feedback reason']),latest?.reason||'');reason.className='feedback-reason';reason.setAttribute('aria-label','Feedback reason');
    const rate=async value=>{
      if(reason.value==='Insufficient mathematical background') value='background';
      const e=await this.store.feedback(paper,value,reason.value,this.state.settings.mode,entry?.probability??null);
      this.state.events.push(e);this.retrain();this.refreshActionRows(paper);this.updateStatus();
      if(this.progress) this.updateProgress();
    };
    row.append(this.button('Like',()=>rate('like'),{'aria-pressed':latest?.value==='like'}),
      this.button('Dislike',()=>rate('dislike'),{'aria-pressed':latest?.value==='dislike'}),
      this.button('Need background',()=>rate('background'),{'aria-pressed':latest?.value==='background'}),
      this.button('Skip',()=>rate('neutral')),this.button('Clear feedback',()=>rate('removed')),reason,
      this.button(this.state.bookmarks[paper.id]?'Bookmarked':'Bookmark',async()=>{
        if(this.state.bookmarks[paper.id]){await this.store.remove('bookmarks',paper.id);delete this.state.bookmarks[paper.id];}
        else {await this.rememberPaper(paper);this.state.bookmarks[paper.id]=isoNow();await this.store.set('bookmarks',paper.id,this.state.bookmarks[paper.id]);}
        this.refreshActionRows(paper);
      },{'aria-pressed':!!this.state.bookmarks[paper.id]}),
      this.button(this.state.reading[paper.id]?'Read':'Mark as read',async()=>{
        if(this.state.reading[paper.id]){await this.store.remove('reading',paper.id);delete this.state.reading[paper.id];}
        else {await this.rememberPaper(paper);this.state.reading[paper.id]=isoNow();await this.store.set('reading',paper.id,this.state.reading[paper.id]);}
        this.refreshActionRows(paper);this.updateProgress();
      },{'aria-pressed':!!this.state.reading[paper.id]}),this.button('AI overview',()=>this.openAI(paper)));
    row._paper=paper;row._entry=entry;
    reason.addEventListener('change',async()=>{const f=this.currentFeedback(paper);if(f&&!['removed','neutral'].includes(f.value)){try{await rate(f.value);}catch(e){this.notify(e.message);}}});
    return row;
  }
  refreshActionRows(paper) {
    for(const root of this.roots) for(const row of root.querySelectorAll('.actions[data-paper-id]')) if(row.dataset.paperId===paper.id) row.replaceWith(this.paperActions(paper,row._entry));
  }
  authorControls(paper) {
    const row=element('div',{class:'authors'},'Authors: ');
    paper.authors.forEach((author,index)=>{
      const subscribed=this.state.subscriptions.find(s=>subscriptionMatches(author,s));
      row.append(link(author.name,author.url||paper.links.abstract),' ',this.button(subscribed?'Following':'Follow',()=>this.follow(author),{'aria-label':`${subscribed?'Manage':'Follow'} ${author.name}`}));
      if(index<paper.authors.length-1) row.append(' · ');
    });return row;
  }
  async follow(author) {
    const existing=this.state.subscriptions.find(s=>subscriptionMatches(author,s));if(existing){this.openAuthors();return;}
    if(!author.stableId&&!confirm(`No stable author identifier is available for ${author.name}. A name-only subscription may include different researchers with the same name. Follow these as possible matches and verify each author's page?`)) return;
    const sub={id:makeId(),name:author.name,url:author.url||'',stableId:author.stableId||null,createdAt:isoNow(),notes:'',confirmedNameOnly:!author.stableId};
    await this.store.set('subscriptions',sub.id,sub);this.state.subscriptions.push(sub);this.notify(`Following ${author.name}${sub.stableId?'':' as a name-only match; verify identity'}.`);
  }
  noSpoilers(paper) {return this.state.settings.paperSpoilers[paper.id]??this.state.settings.noSpoilers;}
  paperProtection(paper) {
    return checkbox('No Spoilers for this paper',this.noSpoilers(paper),async e=>{
      this.state.settings=await this.store.settings({paperSpoilers:{[paper.id]:e.target.checked}});
    });
  }
  paperCard(paper,entry=null,{replace=false}={}) {
    const card=element('article',{class:'card','data-paper-id':paper.id,tabindex:'-1'});
    card.append(element('div',{class:'muted'},entry?.category?`${entry.category} · ${CATEGORIES[entry.category]}`:paper.primaryCategory||'Paper'),
      element('h3',{},link(mathFragment(document,paper.title),paper.links.abstract)),this.authorControls(paper),
      element('p',{class:'muted'},`${paper.id}${paper.version?`v${paper.version}`:''} · ${fmtDate(paper.announcementDate)} · ${paper.section||'arXiv preprint'}`),
      element('div',{},paper.categories.map(c=>element('span',{class:'pill'},c))),
      element('div',{class:'row'},link('Abstract page',paper.links.abstract),link('PDF',paper.links.pdf),paper.links.html?link('HTML',paper.links.html):element('small',{},'No HTML link supplied')));
    const details=element('details',{},element('summary',{},'Original abstract'),element('p',{class:'abstract'},richText(paper,'abstract')));card.append(details);
    if(entry?.reason) card.append(element('p',{class:'muted'},`Selected because: ${entry.reason}`));
    card.append(this.paperActions(paper,entry),this.paperProtection(paper));
    if(this.paperNodes.has(paper.id)) card.append(this.button('Jump to original entry',()=>{this.closePanel();const {dt}=this.paperNodes.get(paper.id);dt.scrollIntoView({block:'center',behavior:'instant'});dt.querySelector('a')?.focus();this.currentPaper=paper;}));
    if(replace) card.append(this.button('Replace this paper',async()=>{
      const next=replaceSelectionPaper(this.activeSelection.current,paper.id,this.listing.papers,{...this.selectionOptions(),seed:makeId()});
      if(!next){this.notify('There is no unused eligible replacement for this category.');return;}
      this.activeSelection.revisions.push(this.activeSelection.current);this.activeSelection.current=next;this.snapshotSelection(this.activeSelection);
      await this.store.set('selections',this.selectionKey(),this.activeSelection);this.state.selections[this.selectionKey()]=this.activeSelection;await this.openDaily();
    }));
    return card;
  }
  selectionKey() {const s=this.state.settings;return `${this.listing.announcementDate}|${s.mode}|${s.includeCross?'cross':'new'}|${s.includeReplacements?'replacements':'originals'}|${s.personalizedCount}`;}
  selectionOptions() {const s=this.state.settings;return {mode:s.mode,seed:makeId(),date:this.listing?.announcementDate,complete:this.listing?.complete,settings:s,model:this.model,subscriptions:this.state.subscriptions,reading:this.state.reading,knownPapers:this.state.papers};}
  snapshotSelection(record) {record.paperSnapshots=record.paperSnapshots||{};for(const e of record.current.entries) if(this.state.papers[e.paperId]) record.paperSnapshots[e.paperId]=this.state.papers[e.paperId];}
  async ensureSelection(regenerate=false) {
    const key=this.selectionKey();let record=await this.store.get('selections',key);
    if(!record||regenerate) {
      const selection=generateSelection(this.listing.papers,this.selectionOptions());
      record=record?{...record,current:selection,revisions:[...record.revisions,record.current]}:{original:selection,current:selection,revisions:[],createdAt:isoNow()};
      this.snapshotSelection(record);await this.store.set('selections',key,record);this.state.selections[key]=record;
    }
    this.activeSelection=record;return record;
  }
  updateProgress() {
    if(!this.progress||!this.activeSelection) return;
    const entries=this.activeSelection.current.entries;const latest=activeFeedback(this.state.events,{...this.state.settings,history:{mode:'all'},resetAt:null}).latest;
    const reviewed=new Set(latest.filter(e=>e.value!=='removed').map(e=>e.paperId));
    const count=entries.filter(e=>this.state.reading[e.paperId]||reviewed.has(e.paperId)).length;
    this.progress.textContent=`${count} / ${entries.length} papers reviewed. This selection ends here; no papers load automatically.`;
  }
  async openDaily() {
    const body=this.panel('Daily discovery','daily');this.progress=null;
    body.append(element('div',{class:'row'},field('Recommendation mode',select(MODES,this.state.settings.mode,async e=>{this.state.settings=await this.store.settings({mode:e.target.value});this.retrain();await this.openDaily();})),this.button('Previous selections',()=>this.openPrevious()),this.button('All papers in a category',()=>this.openCategory())));
    if(!this.listing||!this.listing.announcementDate) {
      body.append(element('p',{class:'notice'},'A daily selection needs a dated arXiv mathematics listing.'),link('Open the new mathematics listing','https://arxiv.org/list/math/new'));return;
    }
    body.append(element('p',{},`Announcement cycle: ${this.listing.announcementDate}. Eligibility: new submissions${this.state.settings.includeCross?', cross-submissions':''}${this.state.settings.includeReplacements?', replacements':''}.`));
    if(!this.listing.complete) {
      body.append(element('p',{class:'notice'},`Only ${this.listing.papers.length} of ${this.listing.advertisedTotal??'an unknown number of'} entries are loaded. Complete the listing before sampling so missing pages cannot bias the selection.`),
        this.button('Load complete publication',async()=>{
          this.notify('Loading the remaining listing pages. Requests are paced and cached.');
          const cached=await this.cache.get(`listing:${this.listing.baseUrl}:${this.listing.announcementDate}`,3600000);
          const result=cached?.complete?cached:await loadCompleteListing(this.listing,{request:gmRequest,onProgress:p=>this.notify(`Loaded ${p.papers} papers across ${p.pages} pages…`)});
          this.listing=result;await this.store.cachePapers(result.papers);for(const p of result.papers)this.state.papers[p.id]=p;
          if(result.complete)await this.cache.set(`listing:${result.baseUrl}:${result.announcementDate}`,result);
          await this.openDaily();
        }),element('ul',{},this.listing.warnings.map(w=>element('li',{},w))));return;
    }
    const record=await this.ensureSelection();if(this.currentPanel!=='daily')return;
    this.progress=element('p',{class:'notice'});body.append(this.progress);this.updateProgress();
    body.append(element('div',{class:'row'},this.button('Regenerate daily selection',async()=>{await this.ensureSelection(true);await this.openDaily();}),
      this.button('Restore original selection',async()=>{record.revisions.push(record.current);record.current=record.original;await this.store.set('selections',this.selectionKey(),record);this.state.selections[this.selectionKey()]=record;await this.openDaily();})),
      element('p',{class:'muted'},'Daily choices stay pinned across refreshes. Feedback and history changes affect the next generation. Random mode ignores learned interests. Under overlapping categories, matching maximizes coverage without duplicate papers.'));
    if(!record.current.entries.length) body.append(element('p',{class:'notice'},this.state.settings.mode==='subscriptions'?'No eligible papers match the followed authors in this publication cycle.':'No eligible papers can be selected from this publication cycle.'));
    for(const entry of record.current.entries) {const paper=record.paperSnapshots?.[entry.paperId]||this.state.papers[entry.paperId];if(paper)body.append(this.paperCard(paper,entry,{replace:true}));}
    if(record.current.missing.length)body.append(element('details',{},element('summary',{},`${record.current.missing.length} categories not represented`),element('ul',{},record.current.missing.map(m=>element('li',{},`${m.category}: ${m.reason}`)))));
    body.append(element('p',{class:'end'},'End of this daily selection.'),element('p',{class:'muted'},'Keyboard: Alt+J / Alt+K next / previous · Alt+L like · Alt+D dislike · Alt+B bookmark · Alt+R read.'));
  }
  openPrevious() {
    const body=this.panel('Previous daily selections','previous');const keys=Object.keys(this.state.selections).sort().reverse();
    if(!keys.length){body.append(element('p',{},'No selections have been saved yet.'));return;}
    let content=element('div');
    const render=key=>{content.replaceChildren();const r=this.state.selections[key];content.append(element('p',{class:'muted'},`${r.current.date} · ${r.current.mode} · ${r.revisions.length} saved revisions`));
      const revisions=[['current','Current selection'],['original','First selection'],...r.revisions.map((_,i)=>[String(i),`Revision ${i+1}`])];
      const cards=element('div');const draw=value=>{const selection=value==='current'?r.current:value==='original'?r.original:r.revisions[Number(value)];cards.replaceChildren(...selection.entries.map(e=>{const p=r.paperSnapshots?.[e.paperId]||this.state.papers[e.paperId];return p?this.paperCard(p,e):element('p',{},`${e.paperId}: metadata unavailable`);}));};
      content.append(field('Saved version',select(revisions,'current',e=>draw(e.target.value))),cards);draw('current');};
    body.append(field('Publication and mode',select(keys.map(k=>[k,k.replaceAll('|',' · ')]),keys[0],e=>render(e.target.value))),content);render(keys[0]);
  }
  openCategory() {
    const body=this.panel('Explore a category','category');
    const list=element('div');let start=0;let current=Object.keys(CATEGORIES)[0];
    const draw=()=>{list.replaceChildren();const papers=(this.listing?.papers||Object.values(this.state.papers)).filter(p=>p.categories.includes(current));
      list.append(element('p',{class:'notice'},`${papers.length} ${this.listing?.complete?'loaded':'locally known'} papers in ${current}. This view includes all loaded submission sections.`));
      for(const paper of papers.slice(start,start+40))list.append(this.paperCard(paper));
      list.append(element('div',{class:'row'},this.button('Previous page',()=>{start=Math.max(0,start-40);draw();},{disabled:start===0}),this.button('Next page',()=>{start+=40;draw();},{disabled:start+40>=papers.length})));};
    body.append(field('Category',select(Object.entries(CATEGORIES).map(([c,n])=>[c,`${c} — ${n}`]),current,e=>{current=e.target.value;start=0;draw();})),list);draw();
  }
  openBookmarks() {
    const body=this.panel('Bookmarks and reading','bookmarks');
    body.append(element('div',{class:'row'},this.button('Export bookmarks (BibTeX)',()=>downloadText('arxiv-bookmarks.bib',bookmarksBibtex(this.state),'application/x-bibtex')),this.button('Export reading history (CSV)',()=>downloadText('arxiv-reading.csv',readingCSV(this.state),'text/csv'))));
    const ids=Object.keys(this.state.bookmarks).sort((a,b)=>this.state.bookmarks[b].localeCompare(this.state.bookmarks[a]));
    body.append(element('h3',{},`${ids.length} bookmarked papers`));if(!ids.length)body.append(element('p',{},'Use Bookmark on any paper to save it here.'));
    this.pagedPapers(body,ids.map(id=>this.state.papers[id]).filter(Boolean));
    const history=element('details',{},element('summary',{},`Reading history (${Object.keys(this.state.reading).length})`));
    history.append(element('ul',{},Object.entries(this.state.reading).sort((a,b)=>String(b[1]).localeCompare(String(a[1]))).map(([id,date])=>element('li',{},`${fmtDate(date)} · `,link(this.state.papers[id]?.title||id,`https://arxiv.org/abs/${id}`)))));body.append(history);
  }
  pagedPapers(body,papers) {
    let page=0;const cards=element('div');body.append(cards);
    const draw=()=>{cards.replaceChildren(...papers.slice(page*40,(page+1)*40).map(p=>this.paperCard(p)));if(papers.length>40)cards.append(element('div',{class:'row'},this.button('Previous page',()=>{page--;draw();},{disabled:page===0}),element('span',{},`Page ${page+1} / ${Math.ceil(papers.length/40)}`),this.button('Next page',()=>{page++;draw();},{disabled:(page+1)*40>=papers.length})));};draw();
  }
  openAuthors() {
    const body=this.panel('Followed researchers','authors');
    body.append(element('p',{class:'notice'},'These subscriptions match locally loaded publication metadata. Name-only matches are possible identities, not verified researchers. Open the linked author page to check. No background scraping runs.'));
    if(!this.state.subscriptions.length)body.append(element('p',{},'Use Follow next to an author on a paper.'));
    for(const sub of this.state.subscriptions) {
      const matches=Object.values(this.state.papers).filter(p=>p.authors.some(a=>subscriptionMatches(a,sub))).sort((a,b)=>String(b.announcementDate).localeCompare(String(a.announcementDate)));
      const notes=element('textarea',{maxlength:2000},sub.notes||'');
      const section=element('section',{class:'card'},element('h3',{},sub.name),element('p',{class:'muted'},`${sub.stableId?`Stable identifier: ${sub.stableId}`:'Name-only subscription: verify identity'} · Followed ${fmtDate(sub.createdAt)} · ${matches.filter(p=>!this.state.reading[p.id]).length} unread`),
        sub.url?link('Check author identity and publications',sub.url):null,field('Private notes',notes),this.button('Save notes',async()=>{sub.notes=notes.value;await this.store.set('subscriptions',sub.id,sub);this.notify('Author notes saved.');}),
        this.button('Unfollow',async()=>{await this.store.remove('subscriptions',sub.id);this.state.subscriptions=this.state.subscriptions.filter(s=>s.id!==sub.id);this.openAuthors();}),
        element('details',{},element('summary',{},`${matches.length} locally known publications`),element('ul',{},matches.map(p=>element('li',{},`${this.state.reading[p.id]?'Read':'Unread'} · ${fmtDate(p.announcementDate)} · `,link(p.title,p.links.abstract))))));
      body.append(section);
    }
  }
  openInterests() {
    const body=this.panel('Interests and training history','interests');
    const f=activeFeedback(this.state.events,this.state.settings);
    body.append(element('p',{class:'notice'},`${f.active.length} active interest examples; ${f.excluded.length} excluded. Only Like and Dislike train the interest model. Need background is tracked separately.`));
    const h=this.state.settings.history;
    const hMode=select([['all','Use all history'],['none','Ignore all history'],['lastDays','Use last X days'],['ignoreLastDays','Ignore last X days'],['before','Ignore before date'],['after','Ignore after date'],['excludeRange','Exclude date range']],h.mode);
    const days=element('input',{type:'number',min:1,max:36500,value:h.days});
    const start=element('input',{type:'date',value:h.start});const end=element('input',{type:'date',value:h.end});
    body.append(element('div',{class:'columns'},field('Training history window',hMode),field('X days',days),field('Date / range start',start),field('Range end',end)),
      this.button('Apply training window',async()=>{
        if(['before','after','excludeRange'].includes(hMode.value)&&!start.value)throw new Error('Choose a date.');
        if(hMode.value==='excludeRange'&&(!end.value||end.value<start.value))throw new Error('Choose an end date on or after the start.');
        const n=Number(days.value);if(['lastDays','ignoreLastDays'].includes(hMode.value)&&(!Number.isFinite(n)||n<1))throw new Error('Enter a positive number of days.');
        this.state.settings=await this.store.settings({history:{mode:hMode.value,days:n,start:start.value,end:hMode.value==='excludeRange'?end.value:''}});this.retrain();this.openInterests();
      }),element('div',{class:'actions'},
      this.button('Reset interests',async()=>{if(!confirm('Start a new active interest profile? Earlier feedback will be retained but excluded. Bookmarks, reading, subscriptions, glossary and knowledge stay saved.'))return;this.state.settings=await this.store.settings({resetAt:isoNow()});this.retrain();this.openInterests();}),
      this.button('Restore all historical interests',async()=>{for(const event of this.state.events)if(event.excluded){event.excluded=false;await this.store.set('events',event.eventId,event);}this.state.settings=await this.store.settings({resetAt:null,history:{mode:'all'}});this.retrain();this.openInterests();}),
      this.button('Analytics',()=>this.openAnalytics()),this.button('Export feedback (CSV)',()=>downloadText('arxiv-feedback.csv',feedbackCSV(this.state),'text/csv'))));
    body.append(element('h3',{},'Current feedback'),element('p',{class:'muted'},'Changing a rating creates a revision. Excluding the current event never brings an older rating back. Delete permanently removes all revisions for that paper.'));
    const events=[...f.latest].reverse();let page=0;const holder=element('div');body.append(holder);
    const draw=()=>{holder.replaceChildren();const table=element('table',{class:'tabular'},element('thead',{},element('tr',{},['Paper','Date','Feedback / reason','Training','Controls'].map(x=>element('th',{},x)))));const rows=element('tbody');
      for(const e of events.slice(page*40,(page+1)*40))rows.append(element('tr',{},element('td',{},link(e.paper?.title||e.paperId,`https://arxiv.org/abs/${e.paperId}`)),element('td',{},fmtDate(e.timestamp)),element('td',{},`${e.value}${e.reason?` · ${e.reason}`:''}`),element('td',{},f.active.some(a=>a.eventId===e.eventId)?'Active':e.excluded?'Individually excluded':'Inactive / non-interest'),element('td',{},
        this.button(e.excluded?'Include event':'Exclude event',async()=>{e.excluded=!e.excluded;await this.store.set('events',e.eventId,e);await this.reload();this.openInterests();}),
        this.button('Delete permanently',async()=>{if(!confirm('Permanently delete every feedback revision for this paper? This cannot be restored without a backup.'))return;await this.store.deleteFeedback([e.paperId]);await this.reload();this.openInterests();},{class:'danger'}))));
      table.append(rows);holder.append(element('div',{class:'table-wrap'},table));if(!events.length)holder.append(element('p',{},'No feedback yet.'));
      if(events.length>40)holder.append(element('div',{class:'row'},this.button('Previous page',()=>{page--;draw();},{disabled:page===0}),this.button('Next page',()=>{page++;draw();},{disabled:(page+1)*40>=events.length})));};draw();
  }
  openAnalytics(startDate='',endDate='') {
    const body=this.panel('Interest analytics','analytics');
    const start=element('input',{type:'date',value:startDate});const end=element('input',{type:'date',value:endDate});
    body.append(element('div',{class:'row'},field('From',start),field('Through',end),this.button('Apply date range',()=>{if(start.value&&end.value&&start.value>end.value)throw new Error('The end date must not precede the start date.');this.openAnalytics(start.value,end.value);})),
      element('p',{class:'notice'},'Observed likes and dislikes describe recorded feedback. Model scores are predictions, not calibrated probabilities. Estimates are withheld when there are fewer than three examples; intervals show sampling uncertainty, not a measurement of identity.'));
    const a=analytics(this.state,{start:startDate,end:endDate,model:this.model});
    body.append(element('p',{},`${a.reviewedCount} reviewed · ${a.positiveCount} likes · ${a.negativeCount} dislikes · ${a.backgroundCount} background requests · ${a.activeCount} active / ${a.excludedCount} excluded training examples`));
    const table=element('table',{class:'tabular'},element('thead',{},element('tr',{},['Category','Reviewed','Likes / dislikes','Background','Observed like share (95% interval)','Model score'].map(x=>element('th',{},x)))),element('tbody',{},a.categories.map(c=>element('tr',{},element('td',{},`${c.code} ${c.name}`),element('td',{},c.reviewed),element('td',{},`${c.positive} / ${c.negative}`),element('td',{},c.background),element('td',{},c.estimate==null?'Insufficient feedback':`${percent(c.estimate)} (${percent(c.interval?.[0]??c.interval?.low)}–${percent(c.interval?.[1]??c.interval?.high)}) · n=${c.positive+c.negative}`),element('td',{},c.prediction==null?'Insufficient feedback':`${Number(c.prediction).toFixed(2)} · ${c.predictionSamples} papers`)))));
    body.append(element('div',{class:'table-wrap'},table));
    const ranked=(title,items)=>element('section',{},element('h3',{},title),items.length?element('ol',{},items.slice(0,30).map(x=>element('li',{},`${x.term} (${x.count})`))):element('p',{class:'muted'},'No data in this range.'));
    body.append(element('div',{class:'columns'},ranked('Frequently liked concepts',a.likedConcepts),ranked('Frequently investigated terms',a.unfamiliarTerms)));
    body.append(element('h3',{},'Feedback over time'),element('table',{class:'tabular'},element('thead',{},element('tr',{},['Period','Likes','Dislikes','Background','Reviewed'].map(x=>element('th',{},x)))),element('tbody',{},a.timeline.map(t=>element('tr',{},[t.period,t.positive,t.negative,t.background,t.reviewed].map(v=>element('td',{},v)))))));
    const trends=element('details',{},element('summary',{},'Changes by mathematical category'),element('p',{class:'muted'},'Counts can overlap because a paper may have several classifications.'));
    for(const t of a.timeline) {
      const cats=Array.isArray(t.categories)?t.categories:Object.entries(t.categories||{}).map(([code,value])=>({code,...value}));
      trends.append(element('h3',{},t.period),element('ul',{},cats.filter(c=>c.reviewed||c.positive||c.negative||c.background).map(c=>element('li',{},`${c.code}: ${c.positive||0} likes, ${c.negative||0} dislikes, ${c.background||0} background requests, ${c.reviewed||0} reviewed`))));
    }
    body.append(trends);
    const readings=Array.isArray(a.readingHistory)?a.readingHistory:[];
    body.append(element('details',{},element('summary',{},`Reading history in this range (${readings.length})`),element('ul',{},readings.map(r=>{const id=r.paperId||r.id;return element('li',{},`${fmtDate(r.timestamp||r.readAt||r.date)} · `,link(r.title||this.state.papers[id]?.title||id,`https://arxiv.org/abs/${id}`));}))));
    body.append(element('details',{},element('summary',{},'Knowledge changes in this range'),element('ul',{},(a.knowledge||[]).map(k=>element('li',{},`${k.term}: ${k.level} (${fmtDate(k.updatedAt)})`,element('ul',{},k.history.map(h=>element('li',{},`${fmtDate(h.updatedAt)}: ${h.level}`))))))));
    body.append(element('details',{},element('summary',{},'Followed researchers in this publication range'),element('ul',{},(a.followedResearchers||[]).map(s=>element('li',{},`${s.name}: ${s.recent.length} locally known publications; ${s.unread.length} unread`)))));
    body.append(element('p',{class:'muted'},`${this.state.subscriptions.length} followed researchers · ${Object.keys(this.state.knowledge).length} explicitly rated knowledge topics. Category counts can overlap for cross-classified papers.`),
      this.button('Reading and bookmarks',()=>this.openBookmarks()),this.button('Knowledge development',()=>this.openKnowledge()),this.button('Followed researchers',()=>this.openAuthors()));
  }
  openKnowledge() {
    const body=this.panel('Mathematical knowledge and glossary','knowledge');
    body.append(element('p',{class:'notice'},'Knowledge is separate from interests. Enter concepts you know, at your own level. Only these explicit levels are sent with an AI request; age and grades are not used.'));
    const topic=element('input',{type:'text',maxlength:100,placeholder:'For example, sequences or linear algebra'});const level=select(LEVELS.map(l=>[l,l]),'Comfortable');
    const saveTopic=async()=>{const name=topic.value.trim();if(!name)throw new Error('Enter a mathematical topic.');const old=this.state.knowledge[name];const at=isoNow();const value={level:level.value,updatedAt:at,history:[...(old?.history||[]),{level:level.value,updatedAt:at}]};await this.store.set('knowledge',name,value);this.state.knowledge[name]=value;this.openKnowledge();};
    body.append(element('div',{class:'row'},field('Topic',topic),field('Knowledge level',level),this.button('Add or update topic',saveTopic)));
    const table=element('table',{class:'tabular'},element('thead',{},element('tr',{},['Topic','Level','History','Remove'].map(x=>element('th',{},x)))),element('tbody',{},Object.entries(this.state.knowledge).map(([name,k])=>element('tr',{},element('td',{},name),element('td',{},select(LEVELS.map(l=>[l,l]),k.level,async e=>{const at=isoNow();k={...k,level:e.target.value,updatedAt:at,history:[...(k.history||[]),{level:e.target.value,updatedAt:at}]};await this.store.set('knowledge',name,k);this.state.knowledge[name]=k;})),element('td',{},element('details',{},element('summary',{},`${k.history?.length||1} recorded level(s)`),element('ul',{},(k.history||[k]).map(h=>element('li',{},`${fmtDate(h.updatedAt)}: ${h.level}`))))),element('td',{},this.button('Remove',async()=>{await this.store.remove('knowledge',name);delete this.state.knowledge[name];this.openKnowledge();}))))));body.append(table);
    body.append(element('h3',{},'Saved glossary'));
    const entries=Object.entries(this.state.glossary).sort((a,b)=>String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)));
    if(!entries.length)body.append(element('p',{},'Highlight a term in a title, abstract, full HTML paper, or explanation, then choose Explain selection.'));
    for(const [key,g] of entries)body.append(element('details',{class:'card'},element('summary',{},`${g.term} · ${g.status||'unfamiliar'} · ${g.visits||1} visit(s)`),element('p',{class:'answer','data-paper-id':g.paperId},mathFragment(document,g.answer)),field('Understanding',select([['unfamiliar','Unfamiliar'],['partial','Partially understood'],['understood','Understood']],g.status||'unfamiliar',async e=>{g.status=e.target.value;g.updatedAt=isoNow();await this.store.set('glossary',key,g);})),this.button('Delete term',async()=>{await this.store.remove('glossary',key);delete this.state.glossary[key];this.openKnowledge();})));
  }
  async pairBridge() {
    const token=prompt('Paste the pairing token printed by your local AI bridge. This is not a hosted-provider API key. The token is stored only in Tampermonkey private storage.');
    if(token===null)return;if(token.trim().length<32)throw new Error('Use the complete random pairing token (at least 32 characters).');
    this.state.settings=await this.store.settings({ai:{token:token.trim()}});if(this.toolbar)this.notify('Local bridge paired. Configure a model and explicitly enable AI in Settings.');
  }
  openSettings() {
    const body=this.panel('Discovery settings','settings');const s=this.state.settings;
    if(this.state.storageWarnings?.length)body.append(element('div',{class:'notice'},'Some saved records could not be loaded:',element('ul',{},this.state.storageWarnings.map(w=>element('li',{},w)))));
    body.append(element('h3',{},'Discovery'),checkbox('Include cross-submissions',s.includeCross,async e=>{this.state.settings=await this.store.settings({includeCross:e.target.checked});}),
      checkbox('Include replacement submissions',s.includeReplacements,async e=>{this.state.settings=await this.store.settings({includeReplacements:e.target.checked});}),
      checkbox('Allow feedback collected in Pure Random mode to train future recommendations',s.trainRandom,async e=>{this.state.settings=await this.store.settings({trainRandom:e.target.checked});this.retrain();this.updateStatus();}),
      checkbox('Use explicit author subscriptions as recommendation signals',s.useSubscriptions,async e=>{this.state.settings=await this.store.settings({useSubscriptions:e.target.checked});}),
      checkbox('Show expandable discovery tools below each paper',s.showTools,async e=>{this.state.settings=await this.store.settings({showTools:e.target.checked});if(e.target.checked)this.attachPaperTools();else{for(const host of this.hosts.filter(h=>h!==this.toolbar))host.remove();this.hosts=this.hosts.filter(h=>h===this.toolbar);this.roots=[this.root];}}),
      checkbox('No Spoilers by default',s.noSpoilers,async e=>{this.state.settings=await this.store.settings({noSpoilers:e.target.checked});}),
      field('Add-on color theme',select([['auto','System'],['light','Light'],['dark','Dark']],s.theme,async e=>{this.state.settings=await this.store.settings({theme:e.target.value});this.updateStatus();}),'Applies only to added controls and panels.'));
    const explore=element('input',{type:'number',min:0,max:100,step:5,value:Math.round(s.exploration*100)});const count=element('input',{type:'number',min:1,max:32,value:s.personalizedCount});
    body.append(element('div',{class:'row'},field('Balanced-mode random exploration (%)',explore),field('Personalized selection size',count),this.button('Save sampling settings',async()=>{const x=Number(explore.value),n=Number(count.value);if(!Number.isFinite(x)||x<0||x>100||!Number.isInteger(n)||n<1||n>32)throw new Error('Use 0–100% exploration and 1–32 papers.');this.state.settings=await this.store.settings({exploration:x/100,personalizedCount:n});this.notify('Sampling settings saved. Existing daily selections remain pinned.');})));
    this.aiSettings(body);
    body.append(element('h3',{},'Backup and data controls'),element('p',{class:'muted'},'JSON backups include personal data and explanations but exclude the pairing token and AI consent. Import validates then merges; it does not delete unrelated records.'),
      element('div',{class:'row'},this.button('Export all data (JSON)',async()=>downloadText('arxiv-discovery-backup.json',JSON.stringify(await this.store.export(),null,2),'application/json')),
      this.button('Export feedback (CSV)',()=>downloadText('arxiv-feedback.csv',feedbackCSV(this.state),'text/csv')),this.button('Export bookmarks (BibTeX)',()=>downloadText('arxiv-bookmarks.bib',bookmarksBibtex(this.state),'application/x-bibtex'))));
    const input=element('input',{type:'file',accept:'.json,application/json','aria-label':'Import a JSON backup'});
    body.append(field('Import a backup',input),this.button('Import selected JSON',async()=>{
      const file=input.files?.[0];if(!file)throw new Error('Choose a JSON backup first.');if(file.size>50000000)throw new Error('The backup exceeds 50 MB.');
      const data=JSON.parse(await file.text());await this.store.import(data);await this.reload();this.openSettings();this.notify('Backup imported. The AI bridge must be paired and enabled again.');
    }));
    const groups=[['events','Feedback'],['bookmarks','Bookmarks'],['reading','Reading history'],['subscriptions','Author subscriptions'],['knowledge','Knowledge profile'],['glossary','Glossary'],['explanations','Cached AI explanations'],['selections','Saved daily selections']];
    const category=select(groups,'events');body.append(field('Selective deletion',category),this.button('Delete selected data',async()=>{if(!confirm(`Permanently delete ${groups.find(g=>g[0]===category.value)[1].toLowerCase()}?`))return;await this.store.clearCollection(category.value);await this.reload();this.openSettings();}),
      this.button('Delete all local data',async()=>{if(!confirm('Permanently delete all arXiv Discovery data, settings, pairing and cached explanations on this browser? Export a backup first if needed.'))return;await this.store.clearAll();await this.cache.clear();await this.reload();this.activeSelection=null;this.openSettings();this.notify('All saved Discovery data has been deleted.');},{class:'danger'}),
      element('p',{class:'version'},'arXiv Discovery 1.0.0 · Independent userscript · Thank you to arXiv for use of its open access interoperability.'),
      link('Source, documentation and issues','https://github.com/sodium-qed/arXiv-scroller'));
  }
  aiSettings(body) {
    const a=this.state.settings.ai;
    body.append(element('h3',{},'Optional AI explanations'),element('p',{class:'notice'},'AI runs only when requested. The paired local bridge retrieves this paper and sends source text, your explicit knowledge profile, the selected term or follow-up, and its surrounding explanation context to the chosen provider. Interest feedback, bookmarks, subscriptions, and browsing history are not sent. Provider keys belong in the bridge environment, never here.'));
    const provider=select([['local','Local OpenAI-compatible model'],['openai','Hosted OpenAI API']],a.provider||'local');
    const url=element('input',{type:'url',value:a.url});const model=element('input',{type:'text',value:a.model,placeholder:'Model allowed by your bridge'});
    const profile=select([['quick','Quick (local; abstract first)'],['full','Detailed (full-paper excerpts)']],a.profile||'quick');
    const timeout=element('input',{type:'number',min:60,max:600,value:a.timeoutSeconds||420});
    const requests=element('input',{type:'number',min:1,max:500,value:a.dailyRequests});const budget=element('input',{type:'number',min:0,max:1000,step:.1,value:a.dailyBudget});
    const chars=element('input',{type:'number',min:1000,max:120000,value:a.maxInputChars});const output=element('input',{type:'number',min:128,max:8192,value:a.maxOutputTokens});
    const inputRate=element('input',{type:'number',min:0,step:.01,value:a.inputPerMillion});const outputRate=element('input',{type:'number',min:0,step:.01,value:a.outputPerMillion});
    const enabled=element('input',{type:'checkbox',checked:a.enabled});const consent=element('input',{type:'checkbox',checked:a.consent});
    for(const input of [provider,url,model])input.addEventListener('input',()=>{consent.checked=false;enabled.checked=false;});
    body.append(element('div',{class:'columns'},field('Provider',provider),field('Local bridge URL',url,'Only http://127.0.0.1 with an optional port is allowed.'),field('Model',model),field('Local reading profile',profile,'Quick caps source at 4,000 characters and output at 768 tokens; protected readings still use the protection filter. Hosted AI uses Detailed.'),field('Request timeout (seconds)',timeout),field('Daily request limit',requests),field('Daily estimated budget (USD)',budget),field('Maximum source characters',chars),field('Maximum output tokens',output),field('Input USD per million tokens (estimate)',inputRate),field('Output USD per million tokens (estimate)',outputRate)),
      element('p',{class:'muted'},`Bridge pairing: ${a.token?'token stored privately':'not paired'}. The server enforces its own provider rates and ceilings; zero browser rates never bypass server budgets.`),this.button('Pair / replace bridge token',()=>this.pairBridge()),
      element('label',{class:'check'},enabled,'Enable on-demand AI'),element('label',{class:'check'},consent,'I authorize this selected provider to receive requested paper text and my explicit knowledge profile.'));
    const estimate=element('p',{class:'muted'});
    const estimateCost=()=>{const value=((4*Number(chars.value)+16000)*Number(inputRate.value)+Number(output.value)*Number(outputRate.value))/1e6;estimate.textContent=`Conservative configured request estimate: up to $${Number.isFinite(value)?value.toFixed(4):'—'} before server ceilings. Actual usage is shown with responses. A ChatGPT subscription is not API credit.`;};
    for(const input of [chars,output,inputRate,outputRate])input.addEventListener('input',estimateCost);estimateCost();body.append(estimate);
    body.append(this.button('Save AI settings',async()=>{
      const u=new URL(url.value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||!['','/'].includes(u.pathname)||u.search||u.hash)throw new Error('Use http://127.0.0.1:PORT without a path or credentials.');
      const n=Number(requests.value),b=Number(budget.value),c=Number(chars.value),o=Number(output.value),ir=Number(inputRate.value),or=Number(outputRate.value),t=Number(timeout.value);
      if(!Number.isInteger(t)||t<60||t>600||!Number.isInteger(n)||n<1||n>500||!Number.isFinite(b)||b<0||!Number.isInteger(c)||c<1000||c>120000||!Number.isInteger(o)||o<128||o>8192||!Number.isFinite(ir)||ir<0||!Number.isFinite(or)||or<0)throw new Error('Use valid positive limits and nonnegative rates.');
      if(enabled.checked&&(!consent.checked||!model.value.trim()||!this.state.settings.ai.token))throw new Error('Pair the bridge, specify a model, and authorize the provider before enabling AI.');
      const changed=provider.value!==(a.provider||'local')||u.origin!==a.url||model.value.trim()!==a.model;
      this.state.settings=await this.store.settings({ai:{provider:provider.value,url:u.origin,model:model.value.trim(),enabled:enabled.checked,consent:consent.checked,dailyRequests:n,dailyBudget:b,maxInputChars:c,maxOutputTokens:o,inputPerMillion:ir,outputPerMillion:or,profile:profile.value,timeoutSeconds:t}});
      this.notify(changed?'AI configuration saved with the selected provider authorization.':'AI settings saved.');
    }));
  }
  async openAI(paper,term='',options={}) {
    const generation=await this.store.generation();
    this.currentPaper=paper;const body=this.panel(term?`Explain: ${term}`:'AI paper overview','ai');body.dataset.paperId=paper.id;
    body.append(element('p',{},link(mathFragment(document,paper.title),paper.links.abstract)),this.paperProtection(paper));
    if(!this.state.settings.ai.enabled||!this.state.settings.ai.consent||!this.state.settings.ai.token) {
      body.append(element('p',{class:'notice'},'AI is optional and is not connected yet. Configure and pair a local bridge in Settings. Discovery, feedback, subscriptions, and bookmarks work without it.'),this.button('Open AI settings',()=>this.openSettings()));return;
    }
    const loading=element('p',{role:'status'},'Retrieving the source and preparing a grounded explanation…');body.append(loading);
    try {
      const config={...options,noSpoilers:this.noSpoilers(paper),onProgress:(phase,chunks)=>{
        if(!loading.isConnected)return;
        loading.textContent=phase==='retrieving'?'Selecting source evidence…':phase==='validating'?'Verifying source quotations…':`Generating explanation locally${chunks?` (${chunks} response chunks received)`:''}…`;
      }};
      const result=term?await this.ai.explain(paper,term,config):await this.ai.overview(paper,config);
      if(!body.isConnected)return;if(generation!==await this.store.generation()){loading.textContent='Saved data changed while this request was running. The answer was not added to the glossary.';return;}loading.remove();
      const source=element('div',{class:'source'},`${result.cached?'Cached · ':''}Source analyzed: ${result.source.kind.toUpperCase()} · `,link('Open analyzed source',result.source.url),element('p',{},result.source.note||''));
      if(result.source.citations?.length) source.append(element('div',{class:'row'},result.source.citations.map(c=>link(c.label,c.url))));
      body.append(source,element('p',{class:'answer','data-paper-id':paper.id},mathFragment(document,result.text)));
      if(result.usage)body.append(element('p',{class:'muted'},`Reported usage: ${result.usage.inputTokens??'unknown'} input / ${result.usage.outputTokens??'unknown'} output tokens · estimated $${Number(result.usage.estimatedCostUsd||0).toFixed(4)}. Verify important mathematical claims against the linked source.`));
      if(term) {
        const key=`${paper.versionedId||paper.id}:${term.toLocaleLowerCase()}`;const old=this.state.glossary[key];const at=isoNow();
        const entry={term,paperId:paper.id,answer:result.text,source:result.source,status:old?.status||'unfamiliar',updatedAt:at,visits:(old?.visits||0)+1,visitHistory:[...(old?.visitHistory||[]),at]};
        if(!await this.store.setIfGeneration('glossary',key,entry,generation))return;this.state.glossary[key]=entry;await this.rememberPaper(paper);
        body.append(field('My understanding',select([['unfamiliar','Unfamiliar'],['partial','Partially understood'],['understood','Understood']],entry.status,async e=>{entry.status=e.target.value;entry.updatedAt=isoNow();await this.store.set('glossary',key,entry);})));
      }
      if(!term&&this.state.settings.ai.provider==='local'&&(this.state.settings.ai.profile||'quick')==='quick'&&options.profile!=='full'&&!options.question&&options.detail!=='rigorous')body.append(this.button('Detailed paper overview',()=>this.openAI(paper,'',{...options,profile:'full'})));
      const question=element('textarea',{maxlength:2000,placeholder:'Ask a follow-up about this paper or term.'});
      body.append(element('div',{class:'actions'},this.button('Simpler explanation',()=>this.openAI(paper,term,{detail:'simpler',context:result.text.slice(0,1600)})),this.button('More rigorous explanation',()=>this.openAI(paper,term,{detail:'rigorous',context:result.text.slice(0,1600)}))),field('Follow-up question',question),this.button('Ask follow-up',()=>{if(!question.value.trim())throw new Error('Enter a follow-up question.');return this.openAI(paper,term,{question:question.value.trim(),context:result.text.slice(0,1600)});}),element('p',{class:'muted'},'Highlight unfamiliar terms inside this explanation to explain them recursively. No Spoilers limits responses to definitions, established background, and research-question context.'));
    } catch(error) {loading.textContent=error.message||String(error);loading.className='notice error';body.append(this.button('Check AI settings',()=>this.openSettings()));}
  }
  handleSelection(event) {
    if(!event.isTrusted||!this.toolbar||event.target?.closest?.('button,input,textarea,select,summary'))return;
    if(event.currentTarget===document&&event.target?.closest?.('[data-arxiv-discovery]'))return;
    const selection=event.currentTarget?.getSelection?.()||window.getSelection();const term=selection?.toString().trim();
    if(!term||term.length>250){this.selectionBubble?.remove();this.selectionBubble=null;return;}
    const range=selection.rangeCount?selection.getRangeAt(0):null;let node=range?.commonAncestorContainer;if(node?.nodeType===3)node=node.parentElement;
    let paper=null;
    const paperId=node?.closest?.('[data-paper-id]')?.dataset.paperId;if(paperId)paper=this.state.papers[paperId];
    if(!paper&&readerTarget(node)) {
      for(const [id,nodes] of this.paperNodes)if(nodes.dd.contains(node)||nodes.dt.contains(node)){paper=this.state.papers[id];break;}
      paper=paper||this.article;
    }
    // Closed shadow selection can be retargeted; only use the current paper inside our answer panel.
    if(!paper&&event.currentTarget===this.root&&this.currentPanel==='ai')paper=this.currentPaper;
    if(!paper)return;
    this.selectionBubble?.remove();const rect=range?.getBoundingClientRect();
    const bubble=element('div',{class:'dictionary-select'});bubble.style.left=`${Math.max(8,Math.min((rect?.left||event.clientX),window.innerWidth-250))}px`;bubble.style.top=`${Math.max(8,Math.min((rect?.bottom||event.clientY)+6,window.innerHeight-60))}px`;
    const context=String(node?.textContent||'').slice(0,1600);
    bubble.append(this.button('Explain selection',()=>{bubble.remove();return this.openAI(paper,term,{context});}));(this.dialog?.open?this.dialog:this.root).append(bubble);this.selectionBubble=bubble;
  }
  handleKeys(event) {
    if(!event.isTrusted||!event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
    if(this.dialog?.open&&this.currentPanel!=='daily')return;
    // Retargeting hides focused controls in a closed shadow from document events.
    const active=[document.activeElement,...this.roots.map(root=>root.activeElement)].filter(Boolean);
    const path=[...event.composedPath(),...active];
    if(path.some(n=>n?.tagName&&(['INPUT','TEXTAREA','SELECT'].includes(n.tagName)||n.isContentEditable)))return;
    const key=event.key.toLowerCase();if(!['j','k','l','d','b','r'].includes(key))return;
    let focusedPaper=null;
    for(const node of active) {
      const id=node.closest?.('[data-paper-id]')?.dataset.paperId;if(id&&this.state.papers[id])focusedPaper=this.state.papers[id];
      if(!focusedPaper)for(const [paperId,nodes] of this.paperNodes)if(nodes.dt.contains(node)||nodes.dd.contains(node)){focusedPaper=this.state.papers[paperId];break;}
    }
    if(focusedPaper)this.currentPaper=focusedPaper;
    let papers=this.activeSelection?.current.entries.map(e=>this.state.papers[e.paperId]).filter(Boolean)||this.listing?.papers||[this.article].filter(Boolean);if(!papers.length)return;
    event.preventDefault();let index=papers.findIndex(p=>p.id===this.currentPaper?.id);
    if(key==='j'||key==='k') {
      index=Math.max(0,Math.min(papers.length-1,index+(key==='j'?1:-1)));const paper=papers[index];this.currentPaper=paper;
      const card=this.body?.querySelector(`[data-paper-id="${CSS.escape(paper.id)}"].card`);if(card){card.focus();card.scrollIntoView({block:'center'});}else{const node=this.paperNodes.get(paper.id)?.dt;node?.scrollIntoView({block:'center'});node?.querySelector('a')?.focus();}return;
    }
    const paper=focusedPaper||papers[Math.max(0,index)];this.currentPaper=paper;
    const run=async()=>{if(key==='l'||key==='d'){const e=await this.store.feedback(paper,key==='l'?'like':'dislike','',this.state.settings.mode);this.state.events.push(e);this.retrain();}
      if(key==='b'){if(this.state.bookmarks[paper.id]){await this.store.remove('bookmarks',paper.id);delete this.state.bookmarks[paper.id];}else{await this.rememberPaper(paper);this.state.bookmarks[paper.id]=isoNow();await this.store.set('bookmarks',paper.id,this.state.bookmarks[paper.id]);}}
      if(key==='r'){if(this.state.reading[paper.id]){await this.store.remove('reading',paper.id);delete this.state.reading[paper.id];}else{await this.rememberPaper(paper);this.state.reading[paper.id]=isoNow();await this.store.set('reading',paper.id,this.state.reading[paper.id]);}}this.refreshActionRows(paper);this.updateProgress();this.updateStatus();};run().catch(e=>this.notify(e.message));
  }
}
