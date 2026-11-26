import {CATEGORIES} from './categories.js';
import {parseListing,parseAbstract,findPaperNodes,readerTarget,listingUrl} from './parser.js';
import {NativeListing} from './native-list.js';
import {trainModel,activeFeedback,analytics,subscriptionMatches} from './recommender.js';
import {generateSelection,replaceSelectionPaper} from './sampling.js';
import {makeId,PublicCache} from './storage.js';
import {AIClient} from './ai.js';
import {element,link,field,select,checkbox,STYLES} from './dom.js';
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
    this.paperTools=new Map();this.inlineAI=new Map();this.mounted=false;this.viewEpoch=0;this.listView=null;
    this.selectionHandler=e=>this.handleSelection(e);this.keyHandler=e=>this.handleKeys(e);
  }
  async initialize() {
    this.state=await this.store.initialize();
    this.listing=document.querySelector('#dlpage')?parseListing(document,location.href):null;
    this.article=this.listing?null:parseAbstract(document,location.href);
    this.paperNodes=findPaperNodes(document,location.href);
    this.nativeListing=new NativeListing(this.paperNodes);
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
      const commands=[['Show arXiv Discovery',()=>this.show()],['Daily selection',()=>this.openDaily()],
        ['Show all papers',()=>this.showAllPapers()],['Previous daily selections',()=>this.openPrevious()],
        ['Explore a category',()=>this.openCategory()],['Bookmarks and reading',()=>this.openBookmarks()],
        ['Followed researchers',()=>this.openAuthors()],['Interests and training history',()=>this.openInterests()],
        ['Knowledge and glossary',()=>this.openKnowledge()],['Discovery settings',()=>this.openSettings()],
        ['Original arXiv',()=>this.hide()],['Pair local AI bridge',()=>this.pairBridge()]];
      for(const [name,action] of commands)GM_registerMenuCommand(name,async()=>{
        try{
          if(name==='Daily selection'||name==='Explore a category')await this.show();
          else if(!['Show arXiv Discovery','Original arXiv','Pair local AI bridge'].includes(name))await this.mount();
          await action();
        }
        catch(error){this.notify(error.message||String(error));}
      });
    }
    if(this.state.settings.mode!=='original') await this.mount();
  }
  retrain() {
    this.model=trainModel(this.state.events,this.state.settings);
    this.latestFeedback=new Map(activeFeedback(this.state.events,this.state.settings).latest.map(event=>[event.paperId,event]));
  }
  async reload() {
    this.state=await this.store.load();
    // Current-page public metadata stays usable after erasure, without silently
    // recreating a deleted persistent collection. A later explicit save records it.
    for(const paper of this.listing?.papers||[this.article].filter(Boolean))if(!this.state.papers[paper.id])this.state.papers[paper.id]=paper;
    this.retrain();this.updateStatus();
    for(const root of this.roots)for(const row of root.querySelectorAll('.actions[data-paper-id]')){const paper=this.state.papers[row.dataset.paperId];if(paper)row.replaceWith(this.paperActions(paper,row._entry));else row.remove();}
    this.refreshPaperSettings();
  }
  async rememberPaper(paper) {await this.store.cachePapers([paper]);this.state.papers[paper.id]=paper;}
  async refreshExternal() {
    this.closePanel();this.clearInlineAI();this.showAllPapers();await this.reload();
    if(this.state.settings.mode==='original')this.unmount();
    else{await this.mount();this.syncPaperTools();this.notify('Changes from another arXiv tab have been loaded.');}
  }
  rootHost(id,parent,before=null) {
    const host=element('div',{id,'data-arxiv-discovery':'true','data-theme':this.state.settings.theme});
    if(!this.nativeLinkColor){const source=document.querySelector('#dlpage dt a[href],a[href*="/abs/"],a[href*="/pdf/"]');if(source)this.nativeLinkColor=getComputedStyle(source).color;}
    if(this.nativeLinkColor)host.style.setProperty('--native-link',this.nativeLinkColor);
    const root=host.attachShadow({mode:'closed'});root.append(element('style',{},STYLES));
    parent.insertBefore(host,before);this.hosts.push(host);this.roots.push(root);
    root.addEventListener('mouseup',e=>this.handleSelection(e));return {host,root};
  }
  async mount() {
    if(this.mounted) return;
    // This empty host has no visible chrome. It only owns explicitly opened
    // management dialogs and contextual dictionary popovers.
    const {host,root}=this.rootHost('arxiv-discovery-dialogs',document.body);
    this.uiHost=host;this.root=root;this.mounted=true;
    this.syncSettingsLauncher();
    if(this.toolsEnabled())this.attachPaperTools();
    document.addEventListener('mouseup',this.selectionHandler);
    document.addEventListener('keydown',this.keyHandler);
    this.updateStatus();
  }
  syncSettingsLauncher() {
    if(!this.mounted)return;
    if(this.state.settings.mode==='original'){
      this.removeHost(this.settingsHost);this.settingsHost=null;this.settingsButton=null;return;
    }
    if(this.settingsHost?.isConnected)return;
    const target=document.querySelector('#dlpage')||document.querySelector('#content-inner')||document.querySelector('.ltx_document')||document.querySelector('main')||document.body;
    const launcher=this.rootHost('arxiv-discovery-settings',target,target.firstChild);
    this.settingsHost=launcher.host;
    this.settingsButton=element('button',{type:'button',class:'settings-launcher','aria-label':'Discovery settings','aria-haspopup':'dialog',onclick:event=>{if(event.isTrusted)this.openSettings();}},'Settings');
    launcher.root.append(this.settingsButton);
  }
  async show() {
    if(this.state.settings.mode==='original'||!this.state.settings.showTools)this.state.settings=await this.store.settings({mode:this.state.settings.mode==='original'?this.state.settings.previousMode||'random':this.state.settings.mode,showTools:true});
    await this.mount();this.syncPaperTools();
  }
  async hide() {
    this.unmount();
    this.state.settings=await this.store.settings({previousMode:this.state.settings.mode==='original'?this.state.settings.previousMode||'random':this.state.settings.mode,mode:'original'});
  }
  unmount() {
    this.showAllPapers();this.closePanel();this.clearInlineAI();
    for(const host of this.hosts)host.remove();this.hosts=[];this.roots=[];this.paperTools.clear();this.uiHost=null;this.root=null;this.settingsHost=null;this.settingsButton=null;this.mounted=false;
    document.removeEventListener('mouseup',this.selectionHandler);document.removeEventListener('keydown',this.keyHandler);
  }
  updateStatus(message='') {
    for(const host of this.hosts) host.setAttribute('data-theme',this.state.settings.theme);
    if(message)this.notify(message);
  }
  notify(text) {
    const previous=this.lastActionRoot;
    const root=previous?.host?.isConnected&&previous!==this.root?previous:this.listRoot||this.paperTools.values().next().value?.root;
    let notice=this.dialog?.open?this.panelNotice:root?.querySelector('.inline-notice');
    if(!notice&&root){notice=element('p',{class:'inline-notice',role:'status','aria-live':'polite'});(root.querySelector('.tools')||root).append(notice);}
    if(notice){notice.textContent=text;notice.hidden=false;}
    else console.info(`arXiv Discovery: ${text}`);
  }
  button(text,callback,attrs={}) {
    return element('button',{type:'button',...attrs,onclick:async e=>{if(!e.isTrusted)return;const b=e.currentTarget;this.lastActionRoot=b.getRootNode();b.disabled=true;try{await callback(e);}catch(error){this.notify(error.message||String(error));}finally{if(b.isConnected)b.disabled=false;}}},text);
  }
  closePanel() {
    this.currentPanel=null;this.selectionBubble?.remove();this.selectionBubble=null;
    if(this.dialog){
      if(this.dialog.open)this.dialog.close();this.dialog.remove();this.dialog=null;this.body=null;this.panelNotice=null;
      const target=this.panelFocus?.isConnected&&!this.panelFocus.disabled?this.panelFocus:this.settingsButton;
      target?.focus({preventScroll:true});this.panelFocus=null;
    }
  }
  panel(title,name) {
    const focused=this.roots.map(root=>root.activeElement).find(Boolean)||document.activeElement;
    this.closePanel();this.panelFocus=focused;this.currentPanel=name;
    const dialog=element('dialog',{'aria-label':title});
    const close=this.button('Close',()=>this.closePanel(),{'aria-label':`Close ${title}`});
    const body=element('div',{class:'dialog-body'});this.panelNotice=element('p',{role:'status','aria-live':'polite',class:'notice',hidden:true});
    body.append(this.panelNotice);dialog.append(element('header',{class:'dialog-header'},element('h2',{},title),close),body);
    this.root.append(dialog);this.dialog=dialog;this.body=body;
    dialog.addEventListener('cancel',event=>{event.preventDefault();this.closePanel();});
    dialog.showModal();return body;
  }
  attachPaperTools() {
    for(const [id,nodes] of this.paperNodes) {
      if(!this.state.papers[id]||this.paperTools.has(id))continue;
      this.addPaperTools(id,nodes.dd);
    }
    if(this.article&&!this.paperNodes.size) {
      const container=document.querySelector('blockquote.abstract,.ltx_abstract')||document.querySelector('h1.title,.ltx_title_document')||document.querySelector('article');
      if(container&&!this.paperTools.has(this.article.id))this.addPaperTools(this.article.id,container.parentNode,container.nextSibling);
    }
  }
  addPaperTools(id,parent,before=null) {
    const {host,root}=this.rootHost(`ad-paper-${id.replace(/[^\w-]/g,'-')}`,parent,before);
    const body=element('div',{class:'tools','data-paper-id':id,role:'group','aria-label':'Paper tools'});
    const tools={host,root,body};this.paperTools.set(id,tools);root.append(body);
    const paper=this.state.papers[id];
    body.append(this.paperActions(paper,this.selectionEntry(id)),this.authorControls(paper),this.paperProtection(paper),this.moreTools());return tools;
  }
  toolsEnabled() {return this.state.settings.mode!=='original'&&this.state.settings.showTools;}
  syncPaperTools() {
    if(!this.mounted)return;
    this.syncSettingsLauncher();
    if(this.toolsEnabled()){this.attachPaperTools();return;}
    this.showAllPapers();this.clearInlineAI();for(const {host} of this.paperTools.values())this.removeHost(host);this.paperTools.clear();
  }
  async setToolsEnabled(enabled) {
    ++this.viewEpoch;
    const patch={showTools:enabled};
    if(enabled&&this.state.settings.mode==='original')patch.mode=this.state.settings.previousMode||'random';
    this.state.settings=await this.store.settings(patch);this.syncPaperTools();
  }
  modePicker() {
    const selected=()=>this.state.settings.mode==='original'?this.state.settings.previousMode||'random':this.state.settings.mode;
    let pending=null;
    const picker=select(MODES,selected(),async event=>{
      if(!event.isTrusted)return;
      if(pending!==null){picker.value=pending;return;}
      const next=picker.value;pending=next;picker.setAttribute('aria-busy','true');
      const epoch=this.viewEpoch,wasDaily=['daily','preparing'].includes(this.listView);let write=null;
      try {
        write=this.store.settings(this.state.settings.mode==='original'?{previousMode:next}:{mode:next});this.modeWrite=write;
        this.state.settings=await write;this.retrain();
        if(wasDaily&&this.mounted&&this.toolsEnabled()&&epoch===this.viewEpoch&&['daily','preparing'].includes(this.listView)){
          const request=++this.viewEpoch,record=await this.ensureSelection(false,request);
          if(request!==this.viewEpoch||!this.mounted)return;
          if(record){
            const keepFocus=picker.getRootNode().activeElement===picker;
            this.renderDaily();
            if(keepFocus&&!picker.isConnected&&!this.dialog?.open){const options=this.listRoot.querySelector('.selection-options');options.open=true;options.querySelector('select')?.focus({preventScroll:true});}
          }else{this.showAllPapers();this.notify('The saved selection is unavailable on this page. Choose Daily selection to try again.');}
        }
      } catch(error){this.notify(error.message||String(error));}
      finally{if(this.modeWrite===write)this.modeWrite=null;pending=null;if(picker.isConnected){picker.value=selected();picker.removeAttribute('aria-busy');}}
    });return picker;
  }
  refreshPaperSettings({authors=true,spoilers=true}={}) {
    for(const [id,tools] of this.paperTools){
      const paper=this.state.papers[id];if(!paper)continue;
      if(authors)tools.root.querySelector('.authors')?.replaceWith(this.authorControls(paper));
      if(spoilers)for(const input of tools.root.querySelectorAll('.paper-protection input'))input.checked=this.noSpoilers(paper);
    }
  }
  removeHost(host) {if(!host)return;host.remove();this.hosts=this.hosts.filter(h=>h!==host);this.roots=this.roots.filter(r=>r.host!==host);}
  clearInlineAI() {for(const body of this.inlineAI.values())body.remove();this.inlineAI.clear();this.selectionBubble?.remove();this.selectionBubble=null;}
  moreTools() {
    const row=element('div',{class:'more-actions'});
    const commands=[['Daily selection',()=>this.openDaily()],['Show all papers',()=>this.showAllPapers()],['Previous selections',()=>this.openPrevious()],['All papers in a category',()=>this.openCategory()],['Bookmarks',()=>this.openBookmarks()],['Authors',()=>this.openAuthors()],['Interests',()=>this.openInterests()],['Knowledge',()=>this.openKnowledge()],['Settings',()=>this.openSettings()],['Original arXiv',()=>this.hide()]];
    for(const [label,action] of commands)row.append(this.button(label,action));
    return element('details',{class:'more-tools'},element('summary',{},'More tools'),row);
  }
  selectionEntry(id) {return this.listView==='daily'?this.activeSelection?.current.entries.find(entry=>entry.paperId===id)||null:null;}
  currentFeedback(paper) {return this.latestFeedback.get(paper.id);}
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
    row.append(this.button('Like',()=>rate('like'),{'aria-pressed':String(latest?.value==='like')}),
      this.button('Dislike',()=>rate('dislike'),{'aria-pressed':String(latest?.value==='dislike')}),
      this.button('Need background',()=>rate('background'),{'aria-pressed':String(latest?.value==='background')}),
      this.button('Skip',()=>rate('neutral')),this.button('Clear feedback',()=>rate('removed')),reason,
      this.button(this.state.bookmarks[paper.id]?'Bookmarked':'Bookmark',async()=>{
        if(this.state.bookmarks[paper.id]){await this.store.remove('bookmarks',paper.id);delete this.state.bookmarks[paper.id];}
        else {await this.rememberPaper(paper);this.state.bookmarks[paper.id]=isoNow();await this.store.set('bookmarks',paper.id,this.state.bookmarks[paper.id]);}
        this.refreshActionRows(paper);
      },{'aria-pressed':String(!!this.state.bookmarks[paper.id])}),
      this.button(this.state.reading[paper.id]?'Read':'Mark as read',async()=>{
        if(this.state.reading[paper.id]){await this.store.remove('reading',paper.id);delete this.state.reading[paper.id];}
        else {await this.rememberPaper(paper);this.state.reading[paper.id]=isoNow();await this.store.set('reading',paper.id,this.state.reading[paper.id]);}
        this.refreshActionRows(paper);this.updateProgress();
      },{'aria-pressed':String(!!this.state.reading[paper.id])}),this.button('AI overview',()=>this.openAI(paper)));
    row._paper=paper;row._entry=entry;
    reason.addEventListener('change',async()=>{const f=this.currentFeedback(paper);if(f&&!['removed','neutral'].includes(f.value)){try{await rate(f.value);}catch(e){this.notify(e.message);}}});
    return row;
  }
  refreshActionRows(paper) {
    const row=this.paperTools.get(paper.id)?.root.querySelector('.actions[data-paper-id]');
    if(row)row.replaceWith(this.paperActions(paper,row._entry));
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
    await this.store.set('subscriptions',sub.id,sub);this.state.subscriptions.push(sub);this.refreshPaperSettings({spoilers:false});this.notify(`Following ${author.name}${sub.stableId?'':' as a name-only match; verify identity'}.`);
  }
  noSpoilers(paper) {return this.state.settings.paperSpoilers[paper.id]??this.state.settings.noSpoilers;}
  paperProtection(paper) {
    const control=checkbox('No Spoilers for this paper',this.noSpoilers(paper),async e=>{
      this.state.settings=await this.store.settings({paperSpoilers:{[paper.id]:e.target.checked}});
      this.refreshPaperSettings({authors:false});
    });
    control.classList.add('paper-protection');return control;
  }
  paperReference(paper,entry=null) {
    const item=element('li',{class:'paper-reference'},link(mathFragment(document,paper.title),paper.links.abstract),
      element('small',{},` · ${paper.id}${entry?.category?` · ${entry.category}`:''}`));
    if(this.paperNodes.has(paper.id))item.append(' ',this.button('Show in listing',()=>{this.closePanel();this.showAllPapers();this.focusPaper(paper.id);}));
    return item;
  }
  selectionKey() {
    const s=this.state.settings;const archive=location.pathname.match(/^\/list\/([^/]+)\//)?.[1]||'math';
    const prefix=`${this.listing.announcementDate}|${s.mode}|${s.includeCross?'cross':'new'}|${s.includeReplacements?'replacements':'originals'}`;
    const numbered=`${prefix}|${s.personalizedCount}|${archive}`;
    if(s.mode==='personalized')return numbered;
    // Older versions included the Personalized size in every mode's key.
    // Reuse those draws without rewriting them; future non-Personalized draws
    // use a key independent of an unrelated setting and the new default size.
    const automatic=`${prefix}|auto|${archive}`;
    if(this.state.selections[numbered])return numbered;
    if(this.state.selections[automatic])return automatic;
    return Object.keys(this.state.selections).filter(key=>key.startsWith(prefix+'|')&&key.endsWith('|'+archive)&&key.split('|').length===6).sort()[0]||automatic;
  }
  selectionOptions() {const s=this.state.settings;return {mode:s.mode,seed:makeId(),date:this.listing?.announcementDate,complete:this.listing?.complete,settings:s,model:this.model,subscriptions:this.state.subscriptions,reading:this.state.reading,knownPapers:this.state.papers};}
  snapshotSelection(record) {record.paperSnapshots=record.paperSnapshots||{};for(const e of record.current.entries) if(this.state.papers[e.paperId]) record.paperSnapshots[e.paperId]=this.state.papers[e.paperId];}
  async ensureSelection(regenerate=false,epoch=this.viewEpoch) {
    const key=this.selectionKey(),options=this.selectionOptions(),generation=await this.store.generation();
    let record=await this.store.get('selections',key);const previous=record;
    const current=()=>this.mounted&&epoch===this.viewEpoch&&key===this.selectionKey();
    if(!current())return null;
    // v1.0 keys lacked archive provenance. Retain them in Previous selections;
    // do not silently reuse a subject-only draw for the complete math archive.
    if(!record||regenerate) {
      const selection=generateSelection(this.listing.papers,options);
      record=record?{...record,current:selection,revisions:[...record.revisions,record.current]}:{original:selection,current:selection,revisions:[],createdAt:isoNow()};
    }
    if(!current()||record.current.entries.some(e=>!this.paperNodes.has(e.paperId)))return null;
    if(!previous||regenerate){
      this.snapshotSelection(record);
      record=previous?await this.store.commitSelectionRevision(key,previous,record.current,record.paperSnapshots,generation):await this.store.getOrCreateSelection(key,record,generation);
      if(!record)return null;
    }
    if(!current()||generation!==await this.store.generation())return null;
    if(record.current.entries.some(e=>!this.paperNodes.has(e.paperId)))return null;
    this.state.selections[key]=record;this.activeSelection=record;this.activeSelectionKey=key;return record;
  }
  updateProgress() {
    if(!this.progress||!this.activeSelection) return;
    const entries=this.activeSelection.current.entries;
    const count=entries.filter(e=>{const event=this.latestFeedback.get(e.paperId);return this.state.reading[e.paperId]||event&&event.value!=='removed';}).length;
    this.progress.textContent=`${count} / ${entries.length} papers reviewed · ${entries.length} selected from ${this.listing.papers.length} entries · ${this.listing.announcementDate}`;
  }
  selectionDistribution(selection) {
    if(!['random','balanced','discovery'].includes(selection.mode))return null;
    const rows=selection.categoryDistribution;
    if(!rows)return element('p',{class:'muted historical-selection'},'This saved selection predates category-distribution snapshots. Its original papers remain pinned; the current sampling rules apply only when a new selection is requested.');
    const discovery=selection.mode==='discovery';
    const eligible=rows.filter(row=>row.eligibleCount>0).length,represented=rows.filter(row=>row.selectedCount>0).length;
    const summary=element('div',{class:'selection-distribution'},
      element('p',{class:'quota-summary'},`Automatically calculated daily target: ${selection.targetSize} papers · Selected: ${selection.entries.length} · Shortfall: ${selection.shortfall}. ${represented} of ${eligible} eligible categories represented.`));
    if(selection.shortfall)summary.append(element('p',{class:'notice'},`${selection.shortfall} category slot(s) could not be filled because cross-listed papers cannot be selected twice. This matching fills the maximum possible number of slots while preserving the widest possible category coverage.`));
    const headings=['Mathematical category','Eligible papers (N)','Square-root quota (⌈√N⌉)',...(discovery?['Discovery quota']:[]),'Selected papers','Reason for unfulfilled quota'];
    const table=element('table',{class:'tabular'},element('thead',{},element('tr',{},headings.map(label=>element('th',{scope:'col'},label)))),
      element('tbody',{},rows.map(row=>element('tr',{'data-category':row.category},
        element('th',{scope:'row'},`${row.category} — ${CATEGORIES[row.category]}`),element('td',{},row.eligibleCount),element('td',{},row.squareRootQuota),
        discovery?element('td',{},row.quota):null,element('td',{},row.selectedCount),element('td',{},row.reason||'Quota fulfilled.')))));
    summary.append(element('details',{class:'category-distribution'},element('summary',{},'Category distribution'),
      element('p',{class:'muted'},discovery?'Discovery applies one slot per nonempty category; square-root quotas are shown for comparison.':'Pure Random and Balanced Exploration apply ⌈√N⌉ slots per category. Interests change paper priorities within a category, never its quota.'),
      element('p',{class:'muted'},'Eligible counts include each paper in every matching category. Selected counts assign each cross-listed paper to one category, so the selected counts sum to the daily selection size.'),element('div',{class:'table-wrap',tabindex:'0','aria-label':'Category distribution table'},table)));
    return summary;
  }
  showAllPapers() {
    ++this.viewEpoch;this.nativeListing?.restore();this.activeSelection=null;this.activeSelectionKey=null;this.listView=null;this.progress=null;
    for(const {root} of this.paperTools.values())root.querySelector('.selection-note')?.remove();
    this.removeHost(this.listHost);this.listHost=null;this.listRoot=null;
    for(const root of this.roots)for(const row of root.querySelectorAll('.actions[data-paper-id]'))if(row._entry)row.replaceWith(this.paperActions(row._paper));
  }
  listingControls() {
    if(!this.mounted)return null;
    if(this.listRoot)return this.listRoot;
    const target=document.querySelector('#dlpage');if(!target)return null;
    const first=this.paperNodes.values().next().value?.dt.closest('dl')||target.querySelector('dl');
    const after=target.querySelector('.morefewer')||target.querySelector('.paging');
    const {host,root}=first?this.rootHost('ad-listing-controls',first.parentNode,first):this.rootHost('ad-listing-controls',after?.parentNode||target,after?.nextSibling||null);
    this.listHost=host;this.listRoot=root;return root;
  }
  completeListingLink() {
    const here=new URL(location.href);
    const candidates=[...document.querySelectorAll('#dlpage .morefewer a,#dlpage .paging a')];
    for(const anchor of candidates) {
      const clean=listingUrl(anchor.getAttribute('href'),here.href);if(!clean)continue;const url=new URL(clean);
      if(anchor.textContent.trim().toLowerCase()==='all'&&url.origin===here.origin&&url.pathname===here.pathname&&Number(url.searchParams.get('skip')||0)===0)return url.href;
    }
    here.searchParams.set('skip','0');here.searchParams.set('show',String(Math.min(2000,Math.max(25,this.listing?.advertisedTotal||2000))));here.hash='';return here.href;
  }
  async openDaily(regenerate=false) {
    const waiting=this.viewEpoch;if(this.modeWrite){await this.modeWrite;if(waiting!==this.viewEpoch)return;}
    if(!this.mounted||!this.toolsEnabled())return;
    this.closePanel();this.showAllPapers();const epoch=this.viewEpoch;
    const root=this.listingControls();
    if(!root||!this.listing?.announcementDate) {
      const tools=this.paperTools.get(this.currentPaper?.id)||this.paperTools.values().next().value;
      if(tools)tools.body.append(element('p',{class:'inline-notice'},'Open a dated mathematics listing to select papers. ',link('New mathematics listing','https://arxiv.org/list/math/new')));return;
    }
    root.append(element('p',{class:'listing-status',role:'status'},'Preparing the daily selection…'),this.button('Show all papers',()=>this.showAllPapers()));
    if(!this.listing.complete) {
      root.querySelector('.listing-status').textContent=`Only ${this.listing.papers.length} of ${this.listing.advertisedTotal??'an unknown number of'} entries are on this arXiv page. Open the complete native listing, then choose Daily selection again.`;
      const target=link('Open complete arXiv listing',this.completeListingLink());target.removeAttribute('target');root.append(' · ',target,
        element('details',{},element('summary',{},'Why sampling is unavailable'),element('p',{},'A selection requires every paper in the publication on the native page. If arXiv still paginates the complete view, sampling remains unavailable; ordinary paper tools continue to work.'),element('ul',{},this.listing.warnings.map(w=>element('li',{},w)))));return;
    }
    this.listView='preparing';const record=await this.ensureSelection(regenerate,epoch);
    if(epoch!==this.viewEpoch||!root.host.isConnected)return;
    if(!record){root.querySelector('.listing-status').textContent='The saved selection cannot be applied to this page. All original entries remain visible. You can generate a new selection from this complete listing.';root.append(this.button('Regenerate daily selection',()=>this.openDaily(true)));return;}
    this.renderDaily();
    this.listHost.scrollIntoView({block:'start'});
  }
  renderDaily() {
    const root=this.listRoot,record=this.activeSelection;if(!root||!record)return;
    for(const child of [...root.children])if(child.tagName!=='STYLE')child.remove();
    this.listView='daily';this.nativeListing.apply(new Set(record.current.entries.map(e=>e.paperId)));
    this.progress=element('span',{class:'listing-status',role:'status','aria-live':'polite'});
    root.append(element('p',{class:'listing-summary'},this.progress,' · ',this.button('Show all papers',()=>this.showAllPapers())));this.updateProgress();
    const distribution=this.selectionDistribution(record.current);if(distribution)root.append(distribution);
    const options=element('details',{class:'selection-options'},element('summary',{},'Selection options'));
    options.append(field('Recommendation mode',this.modePicker()),element('div',{class:'more-actions'},this.button('Regenerate daily selection',()=>this.openDaily(true)),
      this.button('Restore original selection',()=>this.saveSelectionRevision(record.original)),this.button('Previous selections',()=>this.openPrevious()),this.button('All papers in a category',()=>this.openCategory()),this.button('Settings',()=>this.openSettings())),
      element('p',{class:'muted'},`Eligibility: new submissions${this.state.settings.includeCross?', cross-submissions':''}${this.state.settings.includeReplacements?', replacements':''}. Saved choices stay pinned; opening the page itself always shows all native entries.`),
      element('p',{class:'muted'},'Alt+J / Alt+K next / previous · Alt+L like · Alt+D dislike · Alt+B bookmark · Alt+R read.'));
    if(!record.current.categoryDistribution&&record.current.missing.length)options.append(element('details',{},element('summary',{},`${record.current.missing.length} categories not represented`),element('ul',{},record.current.missing.map(m=>element('li',{},`${m.category}: ${m.reason}`)))));
    root.append(options);
    if(!record.current.entries.length)root.append(element('p',{class:'inline-notice'},this.state.settings.mode==='subscriptions'?'No eligible papers match followed authors in this publication.':'No eligible papers can be selected in this publication.'));
    for(const {root:paperRoot} of this.paperTools.values())paperRoot.querySelector('.selection-note')?.remove();
    for(const entry of record.current.entries) {
      const tools=this.paperTools.get(entry.paperId);if(!tools)continue;
      const note=element('div',{class:'selection-note'},element('span',{},`Daily selection${entry.category?` · ${entry.category}`:''} · `),this.button('Replace this paper',()=>this.replacePaper(entry.paperId)),
        element('details',{},element('summary',{},'Why this paper?'),element('p',{},entry.reason||'Chosen for this daily selection.')));
      tools.root.insertBefore(note,tools.body);
      for(const row of tools.root.querySelectorAll('.actions[data-paper-id]'))row.replaceWith(this.paperActions(row._paper,entry));
    }
    const visible=this.nativeListing.visibleIds();
    if(this.currentPaper&&!visible.includes(this.currentPaper.id)){this.currentPaper=null;if(!this.dialog?.open)this.listRoot.querySelector('button')?.focus({preventScroll:true});}
  }
  async saveSelectionRevision(next,focusId=null) {
    const epoch=this.viewEpoch,key=this.activeSelectionKey,record=this.activeSelection,generation=await this.store.generation();
    if(!record||!next||epoch!==this.viewEpoch||key!==this.activeSelectionKey)return;
    const candidate={current:next,paperSnapshots:{...record.paperSnapshots}};this.snapshotSelection(candidate);
    const updated=await this.store.commitSelectionRevision(key,record,next,candidate.paperSnapshots,generation);
    if(epoch!==this.viewEpoch||key!==this.activeSelectionKey)return;
    if(!updated){this.notify('This selection changed in another tab. Reopen Daily selection before changing it again.');return;}
    this.state.selections[key]=updated;this.activeSelection=updated;this.renderDaily();if(focusId)this.focusPaper(focusId);
  }
  async replacePaper(id) {
    const record=this.activeSelection;if(!record)return;
    const next=replaceSelectionPaper(record.current,id,this.listing.papers,{...this.selectionOptions(),seed:makeId()});
    if(!next){this.notify('There is no unused eligible replacement for this category.');return;}
    const replacement=next.entries.find(e=>!record.current.entries.some(old=>old.paperId===e.paperId));
    await this.saveSelectionRevision(next,replacement?.paperId);
  }
  focusPaper(id) {
    const node=this.paperNodes.get(id)?.dt;if(!node||!this.nativeListing.visibleIds().includes(id))return;
    this.currentPaper=this.state.papers[id];node.scrollIntoView({block:'center'});
    (node.querySelector('a[href*="/abs/"]')||node.querySelector('a[href]'))?.focus({preventScroll:true});
  }
  openPrevious() {
    const body=this.panel('Previous daily selections','previous');const keys=Object.keys(this.state.selections).sort((a,b)=>this.state.selections[b].current.date.localeCompare(this.state.selections[a].current.date));
    if(!keys.length){body.append(element('p',{},'No selections have been saved yet.'));return;}
    let content=element('div');
    const render=key=>{content.replaceChildren();const r=this.state.selections[key];content.append(element('p',{class:'muted'},`${r.current.date} · ${r.current.mode} · ${r.revisions.length} saved revisions`));
      const revisions=[['current','Current selection'],['original','First selection'],...r.revisions.map((_,i)=>[String(i),`Revision ${i+1}`])];
      const papers=element('ul'),distribution=element('div');const draw=value=>{const selection=value==='current'?r.current:value==='original'?r.original:r.revisions[Number(value)];const summary=this.selectionDistribution(selection);distribution.replaceChildren(...(summary?[summary]:[]));papers.replaceChildren(...selection.entries.map(e=>{const p=r.paperSnapshots?.[e.paperId]||this.state.papers[e.paperId];return p?this.paperReference(p,e):element('li',{},`${e.paperId}: metadata unavailable`);}));};
      content.append(field('Saved version',select(revisions,'current',e=>draw(e.target.value))),distribution,papers);draw('current');};
    body.append(field('Publication and mode',select(keys.map(k=>[k,k.replaceAll('|',' · ')]),keys[0],e=>render(e.target.value))),content);render(keys[0]);
  }
  openCategory(category=Object.keys(CATEGORIES)[0]) {
    if(!this.mounted)return;
    this.closePanel();this.showAllPapers();const root=this.listingControls();
    if(!root){const body=this.panel('Explore a category','category');body.append(element('p',{},'Open an arXiv mathematics listing to filter its existing entries.'),link('New mathematics listing','https://arxiv.org/list/math/new'));return;}
    this.listView='category';const status=element('p',{class:'listing-status',role:'status'});
    const draw=current=>{
      const ids=this.listing.papers.filter(p=>p.categories.includes(current)).map(p=>p.id);this.nativeListing.apply(new Set(ids));
      status.textContent=`${ids.length} papers in ${current} on this arXiv page${this.listing.complete?'':' (partial listing)'}. All submission sections are included.`;
      if(this.currentPaper&&!this.nativeListing.visibleIds().includes(this.currentPaper.id))this.currentPaper=null;
    };
    root.append(status,element('div',{class:'row'},field('Category',select(Object.entries(CATEGORIES).map(([c,n])=>[c,`${c} — ${n}`]),category,e=>draw(e.target.value))),this.button('Show all papers',()=>this.showAllPapers()),this.button('Daily selection',()=>this.openDaily())));
    draw(category);this.listHost.scrollIntoView({block:'start'});
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
    let page=0;const holder=element('div');body.append(holder);
    const draw=()=>{
      holder.replaceChildren(element('ul',{},papers.slice(page*40,(page+1)*40).map(p=>{
        const item=this.paperReference(p);
        item.append(' ',this.button('Remove bookmark',async()=>{await this.store.remove('bookmarks',p.id);delete this.state.bookmarks[p.id];this.refreshActionRows(p);this.openBookmarks();}));return item;
      })));
      if(papers.length>40)holder.append(element('div',{class:'row'},this.button('Previous page',()=>{page--;draw();},{disabled:page===0}),element('span',{},`Page ${page+1} / ${Math.ceil(papers.length/40)}`),this.button('Next page',()=>{page++;draw();},{disabled:(page+1)*40>=papers.length})));
    };draw();
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
        this.button('Unfollow',async()=>{await this.store.remove('subscriptions',sub.id);this.state.subscriptions=this.state.subscriptions.filter(s=>s.id!==sub.id);this.refreshPaperSettings({spoilers:false});this.openAuthors();}),
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
    this.state.settings=await this.store.settings({ai:{token:token.trim()}});if(this.mounted)this.notify('Local bridge paired. Configure a model and explicitly enable AI in Settings.');
  }
  openSettings() {
    const body=this.panel('Discovery settings','settings');const s=this.state.settings;
    const daily=this.button('Show daily selection',()=>this.openDaily(),{disabled:!this.toolsEnabled()});
    let pendingEnable=null;
    const enabled=checkbox('Enable paper tools',this.toolsEnabled(),async event=>{
      if(!event.isTrusted)return;const input=event.currentTarget;
      if(pendingEnable!==null){input.checked=pendingEnable;return;}
      pendingEnable=input.checked;input.setAttribute('aria-busy','true');
      try{await this.setToolsEnabled(input.checked);daily.disabled=!this.toolsEnabled();}
      catch(error){input.checked=this.toolsEnabled();this.notify(error.message||String(error));}
      finally{pendingEnable=null;if(input.isConnected)input.removeAttribute('aria-busy');}
    });
    body.append(enabled,field('Recommendation mode',this.modePicker()),daily);
    if(this.state.storageWarnings?.length)body.append(element('div',{class:'notice'},'Some saved records could not be loaded:',element('ul',{},this.state.storageWarnings.map(w=>element('li',{},w)))));
    body.append(element('h3',{},'Discovery'),checkbox('Include cross-submissions',s.includeCross,async e=>{this.showAllPapers();this.state.settings=await this.store.settings({includeCross:e.target.checked});}),
      checkbox('Include replacement submissions',s.includeReplacements,async e=>{this.showAllPapers();this.state.settings=await this.store.settings({includeReplacements:e.target.checked});}),
      checkbox('Allow feedback collected in Pure Random mode to train future recommendations',s.trainRandom,async e=>{this.state.settings=await this.store.settings({trainRandom:e.target.checked});this.retrain();this.updateStatus();}),
      checkbox('Use explicit author subscriptions as recommendation signals',s.useSubscriptions,async e=>{this.state.settings=await this.store.settings({useSubscriptions:e.target.checked});}),
      checkbox('No Spoilers by default',s.noSpoilers,async e=>{this.state.settings=await this.store.settings({noSpoilers:e.target.checked});this.refreshPaperSettings({authors:false});}),
      field('Add-on color theme',select([['auto','System'],['light','Light'],['dark','Dark']],s.theme,async e=>{this.state.settings=await this.store.settings({theme:e.target.value});this.updateStatus();}),'Applies only to added controls and panels.'));
    const explore=element('input',{type:'number',min:0,max:100,step:5,value:Math.round(s.exploration*100)});const count=element('input',{type:'number',min:1,max:200,value:s.personalizedCount});
    body.append(element('p',{class:'muted'},'Pure Random and Balanced Exploration automatically select ⌈√N⌉ papers per category, subject to cross-listing conflicts. Discovery keeps one paper per category. Personalized samples globally without category quotas; its default size is 50 papers.'),
      element('div',{class:'row'},field('Balanced-mode random exploration (%)',explore,'Defaults to 25%. Applies to paper priorities within each category.'),field('Personalized selection size',count,'1–200 papers. Applies only to Personalized mode.'),this.button('Save sampling settings',async()=>{const x=Number(explore.value),n=Number(count.value);if(!Number.isFinite(x)||x<0||x>100||!Number.isInteger(n)||n<1||n>200)throw new Error('Use 0–100% exploration and 1–200 papers.');if(n!==this.state.settings.personalizedCount&&this.state.settings.mode==='personalized')this.showAllPapers();this.state.settings=await this.store.settings({exploration:x/100,personalizedCount:n});this.notify('Sampling settings saved. Existing daily selections remain pinned.');})));
    this.aiSettings(body);
    body.append(element('h3',{},'Backup and data controls'),element('p',{class:'muted'},'JSON backups include personal data and explanations but exclude the pairing token and AI consent. Import validates then merges; it does not delete unrelated records.'),
      element('div',{class:'row'},this.button('Export all data (JSON)',async()=>downloadText('arxiv-discovery-backup.json',JSON.stringify(await this.store.export(),null,2),'application/json')),
      this.button('Export feedback (CSV)',()=>downloadText('arxiv-feedback.csv',feedbackCSV(this.state),'text/csv')),this.button('Export bookmarks (BibTeX)',()=>downloadText('arxiv-bookmarks.bib',bookmarksBibtex(this.state),'application/x-bibtex'))));
    const input=element('input',{type:'file',accept:'.json,application/json','aria-label':'Import a JSON backup'});
    body.append(field('Import a backup',input),this.button('Import selected JSON',async()=>{
      const file=input.files?.[0];if(!file)throw new Error('Choose a JSON backup first.');if(file.size>50000000)throw new Error('The backup exceeds 50 MB.');
      const data=JSON.parse(await file.text());await this.store.import(data);this.showAllPapers();this.clearInlineAI();await this.reload();this.syncPaperTools();this.openSettings();this.notify('Backup imported. The AI bridge must be paired and enabled again.');
    }));
    const groups=[['events','Feedback'],['bookmarks','Bookmarks'],['reading','Reading history'],['subscriptions','Author subscriptions'],['knowledge','Knowledge profile'],['glossary','Glossary'],['explanations','Cached AI explanations'],['selections','Saved daily selections']];
    const category=select(groups,'events');body.append(field('Selective deletion',category),this.button('Delete selected data',async()=>{if(!confirm(`Permanently delete ${groups.find(g=>g[0]===category.value)[1].toLowerCase()}?`))return;await this.store.clearCollection(category.value);this.showAllPapers();this.clearInlineAI();await this.reload();this.openSettings();}),
      this.button('Delete all local data',async()=>{if(!confirm('Permanently delete all arXiv Discovery data, settings, pairing and cached explanations on this browser? Export a backup first if needed.'))return;await this.store.clearAll();await this.cache.clear();this.showAllPapers();this.clearInlineAI();await this.reload();this.syncPaperTools();this.openSettings();this.notify('All saved Discovery data has been deleted.');},{class:'danger'}),
      element('p',{class:'version'},'arXiv Discovery 1.2.0 · Independent userscript · Thank you to arXiv for use of its open access interoperability.'),
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
    if(!this.mounted||!this.toolsEnabled())return;
    this.closePanel();
    const tools=this.paperTools.get(paper.id);if(!tools)return;
    this.currentPaper=paper;
    this.inlineAI.get(paper.id)?.remove();
    const title=term?`Explain: ${term}`:'AI paper overview';
    const body=element('section',{class:'inline-ai','data-paper-id':paper.id,'aria-label':title});
    this.inlineAI.set(paper.id,body);tools.body.append(body);
    body.append(element('div',{class:'row'},element('h3',{},title),this.button('Close explanation',()=>{body.remove();if(this.inlineAI.get(paper.id)===body)this.inlineAI.delete(paper.id);})),this.paperProtection(paper));
    const generation=await this.store.generation();if(!body.isConnected||this.inlineAI.get(paper.id)!==body)return;
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
      if(!body.isConnected||this.inlineAI.get(paper.id)!==body)return;if(generation!==await this.store.generation()){loading.textContent='Saved data changed while this request was running. The answer was not added to the glossary.';return;}loading.remove();
      const source=element('div',{class:'source'},`${result.cached?'Cached · ':''}Source analyzed: ${result.source.kind.toUpperCase()} · `,link('Open analyzed source',result.source.url),element('p',{},result.source.note||''));
      if(result.source.citations?.length) source.append(element('div',{class:'row'},result.source.citations.map(c=>link(c.label,c.url))));
      body.append(source,element('p',{class:'answer','data-paper-id':paper.id},mathFragment(document,result.text)));
      if(result.usage)body.append(element('p',{class:'muted'},`Reported usage: ${result.usage.inputTokens??'unknown'} input / ${result.usage.outputTokens??'unknown'} output tokens · estimated $${Number(result.usage.estimatedCostUsd||0).toFixed(4)}. Verify important mathematical claims against the linked source.`));
      if(term) {
        const key=`${paper.versionedId||paper.id}:${term.toLocaleLowerCase()}`;const old=this.state.glossary[key];const at=isoNow();
        const entry={term,paperId:paper.id,answer:result.text,source:result.source,status:old?.status||'unfamiliar',updatedAt:at,visits:(old?.visits||0)+1,visitHistory:[...(old?.visitHistory||[]),at]};
        if(!await this.store.setIfGeneration('glossary',key,entry,generation)||!body.isConnected)return;this.state.glossary[key]=entry;
        if(!await this.store.setIfGeneration('papers',paper.id,paper,generation))return;
        body.append(field('My understanding',select([['unfamiliar','Unfamiliar'],['partial','Partially understood'],['understood','Understood']],entry.status,async e=>{entry.status=e.target.value;entry.updatedAt=isoNow();await this.store.setIfGeneration('glossary',key,entry,generation);})));
      }
      if(!term&&this.state.settings.ai.provider==='local'&&(this.state.settings.ai.profile||'quick')==='quick'&&options.profile!=='full'&&!options.question&&options.detail!=='rigorous')body.append(this.button('Detailed paper overview',()=>this.openAI(paper,'',{...options,profile:'full'})));
      const question=element('textarea',{maxlength:2000,placeholder:'Ask a follow-up about this paper or term.'});
      body.append(element('div',{class:'actions'},this.button('Simpler explanation',()=>this.openAI(paper,term,{detail:'simpler',context:result.text.slice(0,1600)})),this.button('More rigorous explanation',()=>this.openAI(paper,term,{detail:'rigorous',context:result.text.slice(0,1600)}))),field('Follow-up question',question),this.button('Ask follow-up',()=>{if(!question.value.trim())throw new Error('Enter a follow-up question.');return this.openAI(paper,term,{question:question.value.trim(),context:result.text.slice(0,1600)});}),element('p',{class:'muted'},'Highlight unfamiliar terms inside this explanation to explain them recursively. No Spoilers limits responses to definitions, established background, and research-question context.'));
    } catch(error) {loading.textContent=error.message||String(error);loading.className='notice error';body.append(this.button('Check AI settings',()=>this.openSettings()));}
  }
  handleSelection(event) {
    if(!event.isTrusted||!this.mounted||!this.toolsEnabled()||event.target?.closest?.('button,input,textarea,select,summary'))return;
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
    // Closed-shadow selections may be retargeted to their host. Associate each
    // answer with its own paper, never a global last-opened explanation.
    if(!paper&&event.currentTarget?.host)for(const [id,tools] of this.paperTools) {
      if(event.currentTarget===tools.root&&event.target?.closest?.('.inline-ai')){paper=this.state.papers[id];break;}
    }
    if(!paper)return;
    this.selectionBubble?.remove();const rect=range?.getBoundingClientRect();
    const bubble=element('div',{class:'dictionary-select'});bubble.style.left=`${Math.max(8,Math.min((rect?.left||event.clientX),window.innerWidth-250))}px`;bubble.style.top=`${Math.max(8,Math.min((rect?.bottom||event.clientY)+6,window.innerHeight-60))}px`;
    const context=String(node?.textContent||'').slice(0,1600);
    bubble.append(this.button('Explain selection',()=>{bubble.remove();return this.openAI(paper,term,{context});}));(this.dialog?.open?this.dialog:this.root).append(bubble);this.selectionBubble=bubble;
  }
  handleKeys(event) {
    if(!this.mounted||!this.toolsEnabled()||!event.isTrusted||!event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
    if(this.dialog?.open)return;
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
    const papers=this.listing?this.nativeListing.visibleIds().map(id=>this.state.papers[id]).filter(Boolean):[this.article].filter(Boolean);if(!papers.length)return;
    if(focusedPaper&&!papers.some(p=>p.id===focusedPaper.id))focusedPaper=null;
    if(focusedPaper)this.currentPaper=focusedPaper;
    event.preventDefault();let index=papers.findIndex(p=>p.id===this.currentPaper?.id);
    if(key==='j'||key==='k') {
      index=Math.max(0,Math.min(papers.length-1,index+(key==='j'?1:-1)));const paper=papers[index];this.currentPaper=paper;
      this.focusPaper(paper.id);return;
    }
    const paper=focusedPaper||papers[Math.max(0,index)];this.currentPaper=paper;
    const run=async()=>{if(key==='l'||key==='d'){const e=await this.store.feedback(paper,key==='l'?'like':'dislike','',this.state.settings.mode,this.selectionEntry(paper.id)?.probability??null);this.state.events.push(e);this.retrain();}
      if(key==='b'){if(this.state.bookmarks[paper.id]){await this.store.remove('bookmarks',paper.id);delete this.state.bookmarks[paper.id];}else{await this.rememberPaper(paper);this.state.bookmarks[paper.id]=isoNow();await this.store.set('bookmarks',paper.id,this.state.bookmarks[paper.id]);}}
      if(key==='r'){if(this.state.reading[paper.id]){await this.store.remove('reading',paper.id);delete this.state.reading[paper.id];}else{await this.rememberPaper(paper);this.state.reading[paper.id]=isoNow();await this.store.set('reading',paper.id,this.state.reading[paper.id]);}}this.refreshActionRows(paper);this.updateProgress();this.updateStatus();};run().catch(e=>this.notify(e.message));
  }
}
