import {mathFragment} from './math.js';

export function element(tag,attrs={},...children) {
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs||{})) {
    if(value===null||value===undefined||value===false) continue;
    if(key==='class') node.className=value;
    else if(key==='text') node.textContent=value;
    else if(key.startsWith('on')&&typeof value==='function') node.addEventListener(key.slice(2),value);
    else if(key==='checked'||key==='disabled'||key==='selected'||key==='open') node[key]=Boolean(value);
    else node.setAttribute(key,String(value));
  }
  for(const child of children.flat(Infinity)) if(child!==null&&child!==undefined&&child!==false) node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
export function safeURL(value,base='https://arxiv.org') {
  try {const url=new URL(value,base);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;} catch {return null;}
}
export function link(text,url) {
  const clean=safeURL(url);return clean?element('a',{href:clean,target:'_blank',rel:'noopener noreferrer'},text):element('span',{},text);
}
export function field(label,input,help='') {
  const id=`ad-input-${Math.random().toString(36).slice(2)}`;input.id=id;
  return element('div',{class:'field'},element('label',{for:id},label),input,help?element('small',{},help):null);
}
export function select(options,value,change) {
  return element('select',{onchange:change},options.map(([id,label])=>element('option',{value:id,selected:String(id)===String(value)},label)));
}
export function checkbox(label,value,onchange) {
  const input=element('input',{type:'checkbox',checked:value,onchange});
  return element('label',{class:'check'},input,element('span',{},label));
}
export function richText(paper,fieldName) {
  const span=element('span');const text=String(paper[fieldName]||'');let cursor=0;
  for(const item of paper.inlineLinks?.[fieldName]||[]) {
    if(!Number.isInteger(item.start)||!Number.isInteger(item.end)||item.start<cursor||item.end>text.length||item.end<=item.start) continue;
    span.append(mathFragment(document,text.slice(cursor,item.start)),link(mathFragment(document,text.slice(item.start,item.end)),item.url));cursor=item.end;
  }
  span.append(mathFragment(document,text.slice(cursor)));return span;
}
export const STYLES = `
:host{color-scheme:light;--bg:#fff;--fg:#252525;--muted:#626262;--line:#d9d4cc;--soft:#f8f7f4;--accent:#8b1e28;--link:#174e7a;font-family:inherit;font-size:14px;line-height:1.45;display:block;color:inherit}
:host([data-theme=dark]){color-scheme:dark;--bg:#202124;--fg:#ededed;--muted:#b9b9b9;--line:#515359;--soft:#292b30;--accent:#f2a2ac;--link:#a7cafa}
@media(prefers-color-scheme:dark){:host([data-theme=auto]){color-scheme:dark;--bg:#202124;--fg:#ededed;--muted:#b9b9b9;--line:#515359;--soft:#292b30;--accent:#f2a2ac;--link:#a7cafa}}
*{box-sizing:border-box} [hidden]{display:none!important}
button,input,select,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:5px 8px}
button{cursor:pointer;min-height:30px}button:hover{border-color:var(--accent);background:var(--soft)}button[aria-pressed=true]{background:var(--soft);border-color:var(--accent);color:var(--accent);font-weight:bold}button:disabled{opacity:.6;cursor:wait}
a{color:var(--link)}a:hover{text-decoration:underline}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
h2{font-size:21px;margin:0}h3{font-size:17px;margin:16px 0 8px}p{margin:8px 0}small,.muted{color:var(--muted);font-size:12px}
summary{cursor:pointer;display:list-item;max-width:max-content}
:host(#arxiv-discovery-settings){float:right;margin:0 0 8px 12px;max-width:calc(100% - 24px)}.settings-launcher{font-size:13px;min-height:32px;padding:4px 10px}
.tools{margin:5px 0 12px;font-size:13px}.tools summary{color:var(--native-link,#174e7a)}
.tools button,.selection-note button,:host(#ad-listing-controls) button{background:transparent;border:0;border-radius:0;color:var(--native-link,#174e7a);min-height:24px;padding:1px 0;text-decoration:none}
.tools button:hover,.selection-note button:hover,:host(#ad-listing-controls) button:hover{text-decoration:underline}
.tools button[aria-pressed=true]{font-weight:bold;text-decoration:underline}
.actions,.more-actions{display:flex;gap:4px 12px;flex-wrap:wrap;margin:8px 0;align-items:center}.actions button{font-size:12px}
.more-tools{margin-top:8px}.more-actions{font-size:12px}.authors{font-size:13px}.authors button{font-size:12px;margin:0 5px 3px}
.selection-note{font-size:12px;margin:8px 0 2px}.selection-note>details{display:inline-block;margin-left:10px;vertical-align:top}.selection-note p{max-width:70ch}
:host(#ad-listing-controls){margin:12px 0;font-size:14px}.listing-summary{margin:4px 0}.selection-options{font-size:13px;margin:6px 0}.selection-options>.field{margin:8px 0}.selection-options .muted{color:inherit;opacity:.8}
.selection-distribution{font-size:13px;margin:8px 0;max-width:100%;min-width:0}.category-distribution .table-wrap{max-width:100%;margin:8px 0}.category-distribution table{min-width:720px}.category-distribution .muted{color:inherit;opacity:.8}
.inline-notice{font-size:13px;max-width:80ch}.inline-ai{border-left:2px solid var(--line);padding:4px 14px;margin:12px 0;max-width:85ch;background:var(--bg);color:var(--fg)}.inline-ai h3{font-size:15px;margin:5px 0}.inline-ai button{color:var(--link)}
.notice{padding:10px 12px;background:var(--soft);border-left:3px solid var(--accent);margin:10px 0}.error{border-left-color:#bd3030}
dialog{padding:0;border:1px solid var(--line);border-radius:5px;color:var(--fg);background:var(--bg);width:min(940px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:88vh;box-shadow:0 8px 40px #0003}dialog::backdrop{background:#0004}
.dialog-header{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}.dialog-body{padding:4px 20px 20px;overflow-wrap:anywhere}
.card{padding:16px 0;border-bottom:1px solid var(--line)}.card h3{margin:3px 0 5px;font-family:Georgia,'Times New Roman',serif;line-height:1.35}.card:last-child{border-bottom:0}.paper-reference{margin:8px 0}.paper-reference button{font-size:12px;padding:1px 5px;min-height:24px}
.feedback-reason{font-size:12px;max-width:260px}.field{margin:12px 0}.field label{display:block;font-weight:bold;margin-bottom:4px}.field small{display:block;margin-top:4px}.field input,.field select,.field textarea{max-width:100%}.field input:not([type=checkbox]),.field select{min-width:170px}.field textarea{width:100%;min-height:80px}.check{display:flex;gap:8px;align-items:flex-start;margin:10px 0}.check input{margin-top:4px}
.columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px 24px}.tabular{width:100%;border-collapse:collapse;font-size:12px}.tabular th,.tabular td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}.tabular th{background:var(--soft)}.table-wrap{overflow-x:auto}
.answer{white-space:pre-wrap;line-height:1.6;font-family:Georgia,'Times New Roman',serif}.source{font-size:12px;border-bottom:1px solid var(--line);padding-bottom:8px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.danger{color:#b32323}.dictionary-select{position:fixed;z-index:2147483646;max-width:240px;color:var(--fg);background:var(--bg);border:1px solid var(--line);padding:5px;box-shadow:0 2px 12px #0003}.version{font-size:11px;color:var(--muted)}
@media(max-width:600px){.dialog-header{padding:12px}.dialog-body{padding:4px 12px 16px}.columns{display:block}.tabular{font-size:11px}dialog{max-height:94vh;width:calc(100vw - 16px);max-width:calc(100vw - 16px)}.inline-ai{padding:4px 8px}.selection-note>details{margin-left:0;display:block}}
`;
