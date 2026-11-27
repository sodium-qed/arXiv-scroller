export function csvCell(value) { let text=String(value??''); if(/^[\s\u0000-\u001f]*[=+@\-]/.test(text)||/^[\t\r\n]/.test(text)) text=`'${text}`;return `"${text.replace(/"/g,'""')}"`; }
export function feedbackCSV(state) {
  const rows=[['event_id','paper_id','version','timestamp','feedback','reason','mode','excluded','revision_of','title']];
  for(const e of state.events) rows.push([e.eventId,e.paperId,e.version,e.timestamp,e.value,e.reason,e.mode,e.excluded,e.revisionOf,e.paper?.title||state.papers[e.paperId]?.title||'']);
  return rows.map(r=>r.map(csvCell).join(',')).join('\r\n');
}
export function readingCSV(state) {
  return [['paper_id','read_at','title','abstract_url'],...Object.entries(state.reading).map(([id,at])=>[id,at,state.papers[id]?.title||'',state.papers[id]?.links?.abstract||`https://arxiv.org/abs/${id}`])].map(r=>r.map(csvCell).join(',')).join('\r\n');
}
export function bookmarksBibtex(state) {
  // Bibliography metadata is text, never a source of executable TeX commands.
  const tex={'\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','&':'\\&','%':'\\%','#':'\\#','_':'\\_','~':'\\textasciitilde{}','^':'\\textasciicircum{}'};
  const esc=v=>String(v||'').replace(/[\\{}$&%#_~^]/g,c=>tex[c]).replace(/[\r\n]+/g,' ');
  return Object.keys(state.bookmarks).map(id=>state.savedPapers?.[id]||state.papers[id]).filter(Boolean).map(p=>`@misc{arxiv${p.id.replace(/[^a-zA-Z0-9]/g,'')},\n  title = {${esc(p.title)}},\n  author = {${p.authors.map(a=>esc(a.name)).join(' and ')}},\n  eprint = {${esc(p.id)}},\n  archivePrefix = {arXiv},\n  primaryClass = {${esc(p.primaryCategory)}},\n  year = {${String(p.announcementDate||'').slice(0,4)}},\n  url = {https://arxiv.org/abs/${p.id}}\n}`).join('\n\n')+'\n';
}
export function downloadText(filename,text,type='text/plain') {
  const blob=new Blob([text],{type:`${type};charset=utf-8`});const url=URL.createObjectURL(blob);
  // Never expose a private backup's Blob URL in arXiv's public DOM.
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
