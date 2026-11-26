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
:host{color-scheme:light dark;--bg:#fff;--fg:#252525;--muted:#626262;--line:#d9d4cc;--soft:#f8f7f4;--accent:#8b1e28;--link:#174e7a;color:var(--fg);font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;display:block;}
:host([data-theme=dark]){--bg:#202124;--fg:#ededed;--muted:#b9b9b9;--line:#515359;--soft:#292b30;--accent:#f2a2ac;--link:#a7cafa;}
@media(prefers-color-scheme:dark){:host([data-theme=auto]){--bg:#202124;--fg:#ededed;--muted:#b9b9b9;--line:#515359;--soft:#292b30;--accent:#f2a2ac;--link:#a7cafa;}}
*{box-sizing:border-box}button,input,select,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:5px 8px}button{cursor:pointer;min-height:30px}button:hover{border-color:var(--accent);background:var(--soft)}button[aria-pressed=true]{background:var(--soft);border-color:var(--accent);color:var(--accent);font-weight:bold}button:disabled{opacity:.6;cursor:wait}a{color:var(--link)}a:hover{text-decoration:underline}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}h2{font-size:21px;margin:0}h3{font-size:17px;margin:16px 0 8px}p{margin:8px 0}small,.muted{color:var(--muted);font-size:12px}.toolbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:9px 0;margin:12px 0;background:var(--bg)}.brand{font-family:Georgia,serif;font-weight:bold;color:var(--accent);margin-right:5px}.status{width:100%;color:var(--muted);font-size:12px}.tools{margin:5px 0 12px;font-size:12px}.tools summary{cursor:pointer;display:list-item;color:var(--link);max-width:max-content}.actions{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}.actions button{font-size:12px}.notice{padding:10px 12px;background:var(--soft);border-left:3px solid var(--accent);margin:10px 0}.error{border-left-color:#bd3030}.pill{display:inline-block;border:1px solid var(--line);padding:2px 5px;margin:0 5px 4px 0;font-size:11px;border-radius:3px}dialog{padding:0;border:1px solid var(--line);border-radius:5px;color:var(--fg);background:var(--bg);width:min(940px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:88vh;box-shadow:0 8px 40px #0003}dialog::backdrop{background:#0004}.dialog-header{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}.dialog-body{padding:4px 20px 20px;overflow-wrap:anywhere}.card{padding:16px 0;border-bottom:1px solid var(--line)}.card h3{margin:3px 0 5px;font-family:Georgia,'Times New Roman',serif;line-height:1.35}.card:last-child{border-bottom:0}.authors{font-size:13px}.authors button{font-size:11px;min-height:22px;padding:1px 5px;margin:0 5px 3px}.abstract{white-space:pre-wrap;font-family:Georgia,'Times New Roman',serif;line-height:1.55}.feedback-reason{font-size:12px;max-width:260px}.field{margin:12px 0}.field label{display:block;font-weight:bold;margin-bottom:4px}.field small{display:block;margin-top:4px}.field input,.field select,.field textarea{max-width:100%}.field input:not([type=checkbox]),.field select{min-width:170px}.field textarea{width:100%;min-height:80px}.check{display:flex;gap:8px;align-items:flex-start;margin:10px 0}.check input{margin-top:4px}.columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px 24px}.tabular{width:100%;border-collapse:collapse;font-size:12px}.tabular th,.tabular td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}.tabular th{background:var(--soft)}.table-wrap{overflow-x:auto}.answer{white-space:pre-wrap;line-height:1.6;font-family:Georgia,'Times New Roman',serif}.source{font-size:12px;border-bottom:1px solid var(--line);padding-bottom:8px}.end{font-family:Georgia,serif;text-align:center;margin:20px 0;color:var(--muted)}.toolbar button{font-size:12px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.spacer{flex:1}.danger{color:#b32323}.dictionary-select{position:fixed;z-index:2147483646;max-width:240px;background:var(--bg);border:1px solid var(--line);padding:5px;box-shadow:0 2px 12px #0003}.help-key{font-family:monospace;background:var(--soft);padding:1px 4px}.version{font-size:11px;color:var(--muted)}@media(max-width:600px){.dialog-header{padding:12px}.dialog-body{padding:4px 12px 16px}.toolbar{gap:4px}.columns{display:block}.tabular{font-size:11px}dialog{max-height:94vh;width:calc(100vw - 16px);max-width:calc(100vw - 16px)}}
`;
