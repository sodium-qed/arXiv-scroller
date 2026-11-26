import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const entry = 'src/main.js';
const modules = new Map();
function collect(name) {
  if (modules.has(name)) return;
  modules.set(name, '');
  let source = fs.readFileSync(path.join(root, name), 'utf8');
  source = source.replace(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?/g, (_, symbols, spec) => {
    if (!spec.startsWith('.')) throw new Error(`Only local named imports supported: ${spec}`);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), spec));
    collect(target);
    return `const {${symbols.replace(/\bas\b/g, ':')}} = __require(${JSON.stringify(target)});`;
  });
  const exports = [];
  source = source.replace(/export\s+(async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g, (_, a='', type, symbol) => {
    exports.push(symbol); return `${a}${type} ${symbol}`;
  });
  source = source.replace(/export\s*\{([^}]+)\};?/g, (_, names) => {
    for (const name of names.split(',')) exports.push(name.trim().replace(/\s+as\s+/, ': '));
    return '';
  });
  if (/^\s*(import|export)\s/m.test(source)) throw new Error(`Unsupported module syntax in ${name}`);
  modules.set(name, `${source}\nreturn {${exports.join(',')}};`);
}
collect(entry);
const metadata = `// ==UserScript==
// @name         arXiv Discovery
// @namespace    https://github.com/sodium-qed/arXiv-scroller
// @version      ${pkg.version}
// @description  A finite daily mathematics selection, reversible local recommendations, and optional paper explanations. Adds to arXiv without replacing its interface.
// @author       sodium-qed
// @homepageURL  https://github.com/sodium-qed/arXiv-scroller
// @supportURL   https://github.com/sodium-qed/arXiv-scroller/issues
// @downloadURL  https://raw.githubusercontent.com/sodium-qed/arXiv-scroller/main/dist/arxiv-discovery.user.js
// @updateURL    https://raw.githubusercontent.com/sodium-qed/arXiv-scroller/main/dist/arxiv-discovery.user.js
// @match        https://arxiv.org/list/math/*
// @match        https://arxiv.org/list/math.*/*
// @match        https://arxiv.org/list/math-ph/*
// @match        https://arxiv.org/list/cs.IT/*
// @match        https://arxiv.org/list/cs.NA/*
// @match        https://arxiv.org/list/stat.TH/*
// @match        https://arxiv.org/abs/*
// @match        https://arxiv.org/html/*
// @run-at       document-idle
// @sandbox      DOM
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      arxiv.org
// @connect      127.0.0.1
// ==/UserScript==`;
const bundle = `${metadata}\n\n(() => {\n'use strict';\nconst __factories = {\n${[...modules].map(([name,code])=>`${JSON.stringify(name)}: (__require) => {\n${code}\n}`).join(',\n')}\n};\nconst __cache = Object.create(null);\nfunction __require(name) { return __cache[name] || (__cache[name] = __factories[name](__require)); }\n__require(${JSON.stringify(entry)});\n})();\n`;
const out = 'dist/arxiv-discovery.user.js';
fs.mkdirSync(path.dirname(path.join(root,out)), {recursive:true});
fs.writeFileSync(path.join(root,out),bundle);
console.log(`${out}: ${Buffer.byteLength(bundle)} bytes, ${modules.size} modules`);
