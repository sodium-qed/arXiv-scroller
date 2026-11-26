import {temml} from '../vendor/temml.js';

const NS = 'http://www.w3.org/1998/Math/MathML';
const MAX_FIELD = 96_000;
const MAX_FORMULA = 4_096;
const MAX_FORMULAS = 96;
const MAX_NODES = 1_200;
const MAX_DEPTH = 64;
const endOf = new Map([['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]']]);

// AI output occasionally omits math delimiters despite the prompt. Recover only
// recognizable, compact TeX commands and retain the original text as fallback.
// This is intentionally limited to AI explanations, never raw paper content.
const bareCommand = String.raw`\\(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Phi|Psi|Omega|mathbb|mathcal|mathbf|mathrm|mathit|mathop|overline|underline|hat|bar|vec|sqrt|frac|partial|nabla|infty|subset|subseteq|supset|supseteq|in|notin|leq|geq|neq|approx|times|cdot|to|mapsto|rightarrow|leftarrow|sum|prod|int)(?![A-Za-z])`;
const bareArg = String.raw`\{[A-Za-z0-9+\-=_^ ]{0,80}\}`;
const bareScript = String.raw`[_^](?:${bareArg}|[A-Za-z0-9])`;
const bareAtom = String.raw`[A-Za-z](?:${bareScript}){0,3}`;
const bareMacro = String.raw`${bareCommand}(?:${bareArg}){0,2}(?:${bareScript}){0,3}`;
const bareTex = new RegExp(
  String.raw`(?<![\w\\])(?:${bareAtom}(?:[=+*/-]${bareAtom}){0,8}[=+*/(\-]?)?${bareMacro}(?:${bareMacro}|${bareScript}|${bareAtom}|\\[!,;:]|[()+*/\-]|\d{1,12}){0,40}(?:\s+[A-Za-z](?![A-Za-z])(?=\s*[=<>]))?(?:\s*[=<>]\s*(?:[A-Za-z](?![A-Za-z])|\d{1,12}))?`, 'g');

// Also recover compact scripted expressions that have no TeX commands at all.
// Require a braced script and keep the alphabet small so ordinary prose and
// identifiers such as snake_case remain untouched.
const bareBracedScript = String.raw`[_^]\{[A-Za-z0-9,+*/ \-]{1,32}\}`;
const bareScriptedExpression = new RegExp(
  String.raw`(?<![\w\\])(?=[A-Za-z0-9|(])(?=(?:[A-Za-z0-9|()=+*/-]|${bareBracedScript}){0,60}${bareBracedScript})(?:[A-Za-z]{1,3}(?![A-Za-z])|[0-9|()=+*/-]|${bareBracedScript}){1,150}(?![\w])`, 'g');

function bareMathParts(text) {
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(bareTex)) {
    if (match.index > cursor) parts.push({text:text.slice(cursor, match.index)});
    parts.push({text:match[0], tex:match[0], display:false});
    cursor = match.index + match[0].length;
    if (parts.length >= MAX_FORMULAS * 2) break;
  }
  if (cursor < text.length || !parts.length) parts.push({text:text.slice(cursor)});
  return parts;
}

function bareScriptParts(text) {
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(bareScriptedExpression)) {
    if (match.index > cursor) parts.push({text:text.slice(cursor, match.index)});
    parts.push({text:match[0], tex:match[0], display:false});
    cursor = match.index + match[0].length;
    if (parts.length >= MAX_FORMULAS * 2) break;
  }
  if (cursor < text.length || !parts.length) parts.push({text:text.slice(cursor)});
  return parts;
}

function escaped(text, index) {
  let start = index;
  while (start && text[start - 1] === '\\') start--;
  return (index - start) % 2 === 1;
}

// Keep the delimiters in each source slice so any unsupported formula can be
// returned byte for byte. Do not treat a dollar sign followed by space as an opener.
export function mathParts(text) {
  if (text.length > MAX_FIELD) return [{text}];
  const parts = [];
  const delimiters = /\$\$?|\\[()[\]]/g;
  let opening = null;
  let cursor = 0;
  let count = 0;
  for (const match of text.matchAll(delimiters)) {
    const token = match[0];
    const index = match.index;
    if (escaped(text, index)) continue;
    if (opening && endOf.get(opening.token) === token) {
      if (token === '$' && (/\s/.test(text[index - 1]) || /[0-9]/.test(text[index + 1] || ''))) {
        if (text[index + 1] && !/\s/.test(text[index + 1])) opening = {index, token};
        continue;
      }
      const end = index + token.length;
      const tex = text.slice(opening.index + opening.token.length, index);
      if (tex.trim() && tex.length <= MAX_FORMULA) {
        if (cursor < opening.index) parts.push({text:text.slice(cursor, opening.index)});
        parts.push({text:text.slice(opening.index, end), tex, display:['$$', '\\['].includes(opening.token)});
        cursor = end;
        if (++count === MAX_FORMULAS) break;
      }
      opening = null;
    } else if (endOf.has(token) && (!opening || token === '\\(' || token === '\\[' || token === '$$')) {
      if (token === '$' && (!text[index + 1] || /\s/.test(text[index + 1]))) continue;
      opening = {index, token};
    }
  }
  if (cursor < text.length || parts.length === 0) parts.push({text:text.slice(cursor)});
  return parts;
}

const tags = new Set(('math semantics annotation mrow mi mn mo mtext mspace ms ' +
  'mfrac msqrt mroot mstyle merror mphantom mpadded menclose msub msup msubsup ' +
  'munder mover munderover mmultiscripts mprescripts none mtable mtr mtd').split(' '));
const flagAttrs = new Set(('stretchy fence separator symmetric movablelimits largeop ' +
  'accent accentunder displaystyle bevelled').split(' '));
const metricAttrs = new Set('width height depth lspace rspace minsize maxsize linethickness voffset'.split(' '));
const metricStyles = new Set('padding paddingLeft paddingRight paddingTop paddingBottom marginLeft marginRight verticalAlign width height'.split(' '));
const dimension = /^(?:0|[+-]?(?:\d{1,2}(?:\.\d{1,5})?|\.\d{1,5})(?:em|ex|px|pt)|100%|50%)$/;
const plainClasses = /^(?:mathcal|tml-(?:display|prime|(?:sml|med|lrg)-pad|(?:hat|tilde)-[1-4]|jot|small)|(?:chr|wbk)-(?:sml|med|lrg|acc)(?:-acc|-vec)?)$/;
const values = new Map([
  ['display', /^(?:inline|block)$/], ['form', /^(?:prefix|infix|postfix)$/],
  ['mathvariant', /^(?:normal|bold|italic|bold-italic|double-struck|bold-fraktur|script|bold-script|fraktur|sans-serif|bold-sans-serif|sans-serif-italic|sans-serif-bold-italic|monospace)$/],
  ['scriptlevel', /^[+-]?[0-6]$/], ['notation', /^(?:top|bottom)$/],
  ['rowspan', /^[1-9][0-9]?$/], ['columnspan', /^[1-9][0-9]?$/],
  ['columnalign', /^(?:left|center|right)$/], ['rowalign', /^(?:top|bottom|center|baseline|axis)$/],
  ['encoding', /^application\/x-tex$/]
]);

function copyAttributes(element, node) {
  for (const [name, raw] of Object.entries(node.attributes || {})) {
    const value = String(raw);
    if (name === 'xmlns' && value === NS) continue;
    const validator = flagAttrs.has(name) ? /^(?:true|false)$/ : metricAttrs.has(name) ? dimension : values.get(name);
    if (!validator?.test(value)) throw new Error('Unsupported math attribute');
    element.setAttribute(name, value);
  }
  for (const [name, raw] of Object.entries(node.style || {})) {
    const value = String(raw);
    if (name === 'display' && value === 'block math') continue;
    if (name === 'mathDepth' && /^[+-]?[0-6]$/.test(value)) { element.style.mathDepth = value; continue; }
    if (!metricStyles.has(name) || !dimension.test(value)) throw new Error('Unsupported math style');
    element.style[name] = value;
  }
  for (const name of node.classes || []) {
    if (plainClasses.test(name)) continue;
    if (name === 'tml-left' || name === 'tml-right') element.style.textAlign = name.slice(4);
    else if (name === 'tml-overline') element.style.borderTop = '0.065em solid currentColor';
    else if (name === 'tml-underline') element.style.borderBottom = '0.065em solid currentColor';
    else throw new Error('Math layout requires extra fonts or styling');
  }
}

function copyTree(doc, node, budget, depth = 0) {
  if (!node || ++budget.nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('Math layout limit');
  if (!node.type && Object.hasOwn(node, 'text') && typeof node.text === 'string') return doc.createTextNode(node.text);
  // Temml can group infix expressions in a transparent document fragment.
  if (!node.type && Array.isArray(node.children) && !node.attributes && !node.classes?.length &&
      !Object.keys(node.style || {}).length) {
    const fragment = doc.createDocumentFragment();
    for (const child of node.children) fragment.append(copyTree(doc, child, budget, depth + 1));
    return fragment;
  }
  if (!tags.has(node.type) || !Array.isArray(node.children)) throw new Error('Unsupported math element');
  const element = doc.createElementNS(NS, node.type);
  copyAttributes(element, node);
  for (const child of node.children) element.append(copyTree(doc, child, budget, depth + 1));
  return element;
}

// Only insert newly created text and MathML nodes. The pinned renderer returns
// its abstract tree. Neither the paper nor the renderer supplies live markup.
export function mathFragment(doc, value, options = {}) {
  const fragment = doc.createDocumentFragment();
  const source = String(value ?? '');
  const parsed = mathParts(source);
  const parts = options.recoverBareTex && source.length <= MAX_FIELD
    ? parsed.flatMap(part => part.tex === undefined ? bareMathParts(part.text) : [part])
      .flatMap(part => part.tex === undefined ? bareScriptParts(part.text) : [part])
    : parsed;
  let rendered = 0;
  for (const part of parts) {
    if (part.tex !== undefined && rendered++ < MAX_FORMULAS) {
      try {
        const tree = temml.__renderToMathMLTree(part.tex, {
          displayMode:part.display, annotate:true, throwOnError:true, strict:true, trust:false,
          maxExpand:250, maxSize:[12, 72], macros:Object.create(null)
        });
        if (tree.type !== 'math') throw new Error('Unexpected renderer output');
        fragment.append(copyTree(doc, tree, {nodes:0}));
        continue;
      } catch {
        // A custom command, unfamiliar layout, or unusually large expression
        // keeps its exact readable source, including the delimiters.
      }
    }
    fragment.append(doc.createTextNode(part.text));
  }
  return fragment;
}
