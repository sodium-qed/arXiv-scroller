import { normalizeCategory } from './categories.js';

const LISTS = 'dl[id="articles"], dl.articles';
const SECTIONS = ['new', 'cross', 'replacement'];
const MONTHS = 'january february march april may june july august september october november december'.split(' ');
const ORIGIN = 'https://arxiv.org';
const DEFAULT_LIST = ORIGIN + '/list/math/new';

function webUrl(raw, base) {
  if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u001f\\]/.test(raw)) return null;
  try {
    const url = new URL(raw, base);
    return /^(?:http|https):$/.test(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function arxivUrl(raw, base) {
  const url = webUrl(raw, base);
  if (!url || !/^(?:www\.)?arxiv\.org$/.test(url.hostname) || url.port) return null;
  url.protocol = 'https:';
  url.hostname = 'arxiv.org';
  return url;
}

// Ignore a fetched document's <base>. Only follow the same authoritative listing.
export function listingUrl(raw, base = DEFAULT_LIST) {
  const url = arxivUrl(raw, base);
  const current = arxivUrl(base, DEFAULT_LIST);
  if (!url || !current || !/^\/list\/[a-z][a-z.-]*\/(?:new|recent)\/?$/i.test(url.pathname)) return null;
  if (url.pathname.replace(/\/$/, '') !== current.pathname.replace(/\/$/, '')) return null;
  for (const [key, value] of url.searchParams) {
    if (!['skip', 'show'].includes(key) || url.searchParams.getAll(key).length !== 1) return null;
    if (!/^\d{1,9}$/.test(value) || (key === 'show' && Number(value) === 0)) return null;
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.searchParams.sort();
  url.hash = '';
  return url.href;
}

function paperId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/^arXiv:\s*/i, '');
  const match = /^((?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{2}(?:0[1-9]|1[0-2])\d{3}))(?:v([1-9]\d{0,6}))?$/i.exec(value);
  if (!match) return null;
  // Pre-2007 subject-class suffixes are optional in the printed identifier.
  const id = match[1].replace(/\.[a-z]{2}(?=\/)/i, '').toLowerCase();
  const version = Number(match[2] || 0);
  return { id, version, versionedId: version ? id + 'v' + version : id };
}

function paperRoute(raw, base) {
  const url = arxivUrl(raw, base);
  if (!url) return null;
  const match = /^\/(abs|pdf|html)\/(.+?)\/?$/.exec(url.pathname);
  if (!match) return null;
  const [, format, path] = match;
  const token = format === 'pdf' ? path.replace(/\.pdf$/i, '') : path.replace(/\/index\.html$/i, '');
  const identity = paperId(token);
  return identity && { ...identity, format, url: ORIGIN + '/' + format + '/' + identity.versionedId };
}

function orcidId(raw) {
  if (!raw) return null;
  const match = /^(?:https?:\/\/(?:www\.)?orcid\.org\/|orcid:\s*)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\/?$/i.exec(raw.trim());
  if (!match) return null;
  const code = match[1].toUpperCase();
  const digits = code.replace(/-/g, '');
  let sum = 0;
  for (const digit of digits.slice(0, -1)) sum = 2 * (sum + Number(digit));
  const check = (12 - (sum % 11)) % 11;
  return digits.at(-1) === (check === 10 ? 'X' : String(check)) ? 'orcid:' + code : null;
}

function authorIdentity(anchor, base) {
  const href = anchor.getAttribute('href');
  const url = webUrl(href, base);
  let stableId = orcidId(anchor.getAttribute('data-orcid'));
  let authorUrl = null;
  if (url && /^(?:www\.)?orcid\.org$/.test(url.hostname) && !url.port) {
    const orcid = orcidId('https://orcid.org' + url.pathname);
    if (orcid) {
      stableId = orcid;
      authorUrl = 'https://orcid.org/' + orcid.slice(6);
    }
  }
  const arxiv = arxivUrl(href, base);
  if (arxiv) {
    const profile = /^\/a\/([a-z0-9_-]+_\d+)(?:\.html)?\/?$/i.exec(arxiv.pathname);
    if (profile) stableId ||= 'arxiv:' + profile[1].toLowerCase();
    if (/^\/search(?:\/|$)/.test(arxiv.pathname)) {
      if (arxiv.searchParams.get('searchtype') === 'orcid') {
        stableId ||= orcidId(arxiv.searchParams.get('query'));
      }
      authorUrl = arxiv.href;
    } else if (profile) {
      authorUrl = arxiv.href;
    }
  }
  return { url: authorUrl, stableId };
}

function readAuthors(container, base) {
  if (!container) return [];
  const authors = [];
  let precedingAuthor = null;
  for (const anchor of container.querySelectorAll('a')) {
    const name = readField(anchor, base).text;
    const identity = authorIdentity(anchor, base);
    const badge = !name || /^(?:ORCID(?: iD)?|arXiv ID|ID|icon)$/i.test(name) || orcidId(name);
    if (badge) {
      // An identifier icon is often the immediate sibling of the person's name.
      if (precedingAuthor && identity.stableId && precedingAuthor.anchor.nextElementSibling === anchor) {
        precedingAuthor.record.stableId ||= identity.stableId;
      }
      continue;
    }
    const record = { name, ...identity };
    authors.push(record);
    precedingAuthor = { anchor, record };
  }
  return authors;
}

function readField(root, base) {
  let text = '';
  let pendingSpace = false;
  const links = [];
  function append(value) {
    const normalized = value.replace(/[ \n\r\t\f]+/g, ' ');
    if (!normalized) return;
    const core = normalized.replace(/^ | $/g, '');
    if (core) {
      if (text && !text.endsWith('\n') && (pendingSpace || normalized.startsWith(' '))) text += ' ';
      text += core;
    }
    pendingSpace = normalized.endsWith(' ');
  }
  function lineBreak() {
    pendingSpace = false;
    if (text && !text.endsWith('\n')) text += '\n';
  }
  function mathText(node) {
    const annotation = node.querySelector('annotation[encoding*="tex" i]');
    const tex = node.getAttribute('alttext') || annotation?.textContent;
    if (tex) {
      const block = node.getAttribute('display') === 'block';
      append(block ? '\\[' + tex + '\\]' : '\\(' + tex + '\\)');
    } else {
      append(node.getAttribute('aria-label') || node.querySelector('semantics > :first-child')?.textContent || node.textContent);
    }
  }
  function walk(node) {
    if (node.nodeType === 3) { append(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    if (node.matches('script[type^="math/tex" i]')) {
      const display = /mode\s*=\s*display/i.test(node.type);
      append(display ? '\\[' + node.textContent + '\\]' : '\\(' + node.textContent + '\\)');
      return;
    }
    // Class selectors become ASCII case-insensitive in quirks-mode fragments.
    // arXiv's ordinary .mathjax source must not be mistaken for generated .MathJax.
    if (node.matches('script,style,template,noscript,iframe,object,embed,svg,canvas,.descriptor,.ltx_title_abstract,[hidden]') ||
        ['MathJax_Preview','MathJax','MathJax_Display','MathJax_CHTML','MathJax_SVG','MJX_Assistive_MathML'].some(name => node.classList.contains(name))) return;
    if (node.matches('mjx-container')) {
      const source = node.querySelector('math');
      if (source) mathText(source);
      else if (node.getAttribute('aria-label')) append(node.getAttribute('aria-label'));
      return;
    }
    if (node.localName === 'math') { mathText(node); return; }
    if (node.localName === 'br') { lineBreak(); return; }
    const block = node !== root && node.matches('p,div.ltx_para');
    if (block) lineBreak();
    const start = text.length;
    for (const child of node.childNodes) walk(child);
    if (node.localName === 'a' && text.length > start) {
      const url = webUrl(node.getAttribute('href'), base);
      const offset = text.slice(start).search(/\S/);
      if (url && offset >= 0) links.push({ start: start + offset, end: text.length, url: url.href });
    }
    if (block) lineBreak();
  }
  if (root) walk(root);
  return { text: text.trimEnd(), links };
}

function readSubjects(node) {
  const categories = [];
  function extract(raw) {
    const tokens = [...raw.matchAll(/\(([\w.-]+)\)/g)].map(match => match[1]);
    if (!tokens.length) tokens.push(...raw.trim().split(/[;,\s]+/));
    return tokens.map(normalizeCategory).filter(Boolean);
  }
  const primary = extract(node?.querySelector('.primary-subject, .primary-subjects')?.textContent || '')[0];
  if (primary) categories.push(primary);
  for (const code of extract(node?.textContent || '')) if (!categories.includes(code)) categories.push(code);
  return { categories, primaryCategory: primary || categories[0] || null };
}

function readFields(paper, nodes, base) {
  for (const [field, node] of Object.entries(nodes)) {
    const { text, links } = readField(node, base);
    paper[field] = text;
    if (links.length) {
      paper.inlineLinks ||= {};
      paper.inlineLinks[field] = links;
    }
  }
}

function formats(abstractRoute, candidates, fallbackVersion = 0) {
  let html = null;
  let pdf = null;
  let version = abstractRoute.version;
  // A version-specific abstract always wins. Ignore a mismatched full-text version.
  for (const route of candidates) {
    if (!route || route.id !== abstractRoute.id || (version && route.version && route.version !== version)) continue;
    if (route.format === 'html') html ||= route;
    if (route.format === 'pdf') pdf ||= route;
    version ||= route.version;
  }
  version ||= fallbackVersion;
  const id = abstractRoute.id;
  const versionedId = version ? id + 'v' + version : id;
  return {
    id, version, versionedId,
    links: {
      abstract: ORIGIN + '/abs/' + abstractRoute.versionedId,
      pdf: pdf?.url || ORIGIN + '/pdf/' + versionedId,
      html: html?.url || null,
    },
  };
}

function rowIdentity(dt, base) {
  const anchor = dt.querySelector('a[title="Abstract" i], a[href^="/abs/"]');
  const route = paperRoute(anchor?.getAttribute('href'), base);
  return route?.format === 'abs' ? route : null;
}

function parseRow(dt, dd, route, section, date, base) {
  const candidates = [...dt.querySelectorAll('a[href]')].map(a => paperRoute(a.getAttribute('href'), base));
  const paper = {
    ...formats(route, candidates, section === 'new' ? 1 : 0),
    authors: readAuthors(dd.querySelector('.list-authors'), base),
    ...readSubjects(dd.querySelector('.list-subjects')),
    announcementDate: date, section,
  };
  readFields(paper, {
    title: dd.querySelector('.list-title'),
    abstract: dd.querySelector('p.mathjax, .list-abstract'),
    comments: dd.querySelector('.list-comments'),
    journalRef: dd.querySelector('.list-journal-ref, .list-jref'),
  }, base);
  return paper;
}

function parseDateHeading(value) {
  const normalized = value.trim().replace(/\s+/g, ' ');
  const heading = normalized.replace(/^(?:(?:showing\s+)?(?:new\s+)?(?:listings?|submissions?|announcements?)\s+(?:for|on)\s+|(?:cross|replacement)\s+submissions?\s+for\s+)/i, '')
    .replace(/^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?),?\s+/i, '')
    .replace(/\s+\((?:continued|showing|total)\b.*$/i, '');
  let year, month, day;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(heading);
  const dmy = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i.exec(heading);
  const mdy = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(heading);
  if (iso) [, year, month, day] = iso.map(Number);
  else if (dmy || mdy) {
    const parts = dmy || mdy;
    year = Number(parts[3]);
    day = Number(parts[dmy ? 1 : 2]);
    const spelled = parts[dmy ? 2 : 1].toLowerCase();
    month = MONTHS.findIndex(name => name === spelled || name.slice(0, 3) === spelled ||
      (name === 'september' && spelled === 'sept')) + 1;
  } else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1991 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function sectionHeading(text) {
  if (/^new\s+(?:submissions?|articles?|papers?)\b/i.test(text)) return 'new';
  if (/^cross[- ]?(?:submissions?|list(?:ed|ings?|s)?)\b/i.test(text)) return 'cross';
  if (/^replacements?\b/i.test(text)) return 'replacement';
  return null;
}

function countClaim(text) {
  const match = /\bshowing\s+(?:(?:items|first|last)\s+)?([\d,]+)(?:\s*[-–—]\s*([\d,]+))?\s+(?:of|out of)\s+([\d,]+)\s+(?:entr(?:y|ies)|items?|articles?)/i.exec(text);
  if (!match) return null;
  const first = Number(match[1].replace(/,/g, ''));
  const shown = match[2] ? Number(match[2].replace(/,/g, '')) - first + 1 : first;
  return { shown, total: Number(match[3].replace(/,/g, '')) };
}

function navigation(page, base) {
  const links = new Map();
  for (const anchor of page.querySelectorAll('.paging a[href], .morefewer a[href], .pagination a[href], a[rel~="next"], a[rel~="prev"]')) {
    const label = anchor.textContent.trim().toLowerCase();
    const url = listingUrl(anchor.getAttribute('href'), base);
    if (!url || /^(?:fewer|less)$/.test(label) || url === listingUrl(base, base)) continue;
    const rank = label === 'all' ? 0 : label === 'more' ? 1 : 2;
    if (!links.has(url) || links.get(url) > rank) links.set(url, rank);
  }
  return [...links].sort((a, b) => a[1] - b[1]).map(([url]) => url);
}

export function listingCounts(papers) {
  const counts = { new: 0, cross: 0, replacement: 0, total: papers.length };
  for (const paper of papers) if (SECTIONS.includes(paper.section)) counts[paper.section]++;
  return counts;
}

export function parseListing(doc, baseUrl = doc.URL || DEFAULT_LIST) {
  if (/\/recent\/?$/.test(arxivUrl(baseUrl, DEFAULT_LIST)?.pathname || '')) return parseRecentListing(doc, baseUrl);
  const page = doc.querySelector('#dlpage') || doc;
  const sourceUrl = arxivUrl(baseUrl, DEFAULT_LIST);
  const base = sourceUrl ? sourceUrl.href : DEFAULT_LIST;
  const sectionsByList = new WeakMap();
  const sectionTotals = {};
  const integrity = new Set();
  const records = new Map();
  const claims = [];
  let externalSection = null;
  let date = null;
  let currentDate = null;
  let brokenPairs = 0;
  let unclassified = 0;
  let malformed = 0;
  let duplicates = 0;
  let missingSubjects = 0;
  for (const node of page.querySelectorAll('h2,h3,h4,dt,dd')) {
    const list = node.closest(LISTS);
    if (/^H[234]$/.test(node.tagName)) {
      if (node.closest('dt,dd')) continue;
      const label = node.textContent.trim();
      const announced = parseDateHeading(label);
      if (announced) {
        currentDate = announced;
        date ||= announced;
        if (currentDate !== date) integrity.add('This page contains multiple announcement dates. Only the first publication cycle was read.');
      }
      if (currentDate !== date) continue;
      const section = sectionHeading(label);
      const claim = section ? { section, ...countClaim(label), rows: 0 } : null;
      if (claim) {
        claims.push(claim);
        if (Number.isFinite(claim.total)) {
          if (section in sectionTotals && sectionTotals[section] !== claim.total) {
            integrity.add('The listing contains conflicting totals for ' + section + ' submissions.');
          }
          sectionTotals[section] = claim.total;
        }
      }
      if (list) sectionsByList.set(list, claim);
      else externalSection = claim;
      continue;
    }
    if (!list || node.parentElement !== list || currentDate !== date) continue;
    if (node.localName === 'dd') {
      if (node.previousElementSibling?.localName !== 'dt') brokenPairs++;
      continue;
    }
    const claim = sectionsByList.has(list) ? sectionsByList.get(list) : externalSection;
    if (claim) claim.rows++;
    const dd = node.nextElementSibling;
    if (dd?.localName !== 'dd') { brokenPairs++; continue; }
    if (!claim) { unclassified++; continue; }
    const identity = rowIdentity(node, base);
    if (!identity) { malformed++; continue; }
    const paper = parseRow(node, dd, identity, claim.section, currentDate, base);
    if (!paper.title) { malformed++; continue; }
    if (records.has(paper.id)) { duplicates++; continue; }
    if (!paper.categories.length) missingSubjects++;
    records.set(paper.id, paper);
  }

  if (!date) integrity.add('The listing does not identify a valid announcement date.');
  if (!page.querySelector(LISTS) && !page.querySelector('.paging')) integrity.add('No arXiv article list or pagination summary was found.');
  if (brokenPairs) integrity.add('Unpaired paper headers or descriptions: ' + brokenPairs + '.');
  if (unclassified) integrity.add('Entries without a recognized submission section: ' + unclassified + '.');
  if (malformed) integrity.add('Entries without a valid arXiv identifier and title: ' + malformed + '.');
  if (duplicates) integrity.add('Repeated paper identifiers on this page: ' + duplicates + '.');
  if (missingSubjects) integrity.add('Entries without readable subject classifications: ' + missingSubjects + '.');
  for (const claim of claims) {
    if (Number.isFinite(claim.shown) && (claim.shown !== claim.rows || claim.shown > claim.total)) {
      integrity.add('The displayed row count disagrees with the ' + claim.section + ' section heading.');
    }
  }

  const totals = new Set();
  for (const box of page.querySelectorAll('.paging, .pagination')) {
    const match = /\btotal\s+(?:of\s+)?([\d,]+)\s+(?:entr(?:y|ies)|articles?|items?)\b/i.exec(box.textContent);
    if (match) totals.add(Number(match[1].replace(/,/g, '')));
  }
  if (totals.size > 1) integrity.add('The pagination controls report conflicting entry totals.');
  const fullBreakdown = SECTIONS.every(section => section in sectionTotals);
  const sectionSum = Object.values(sectionTotals).reduce((a, b) => a + b, 0);
  const advertisedTotal = [...totals][0] ?? (fullBreakdown ? sectionSum : null);
  if (fullBreakdown && advertisedTotal !== sectionSum) integrity.add('Section totals disagree with the advertised daily total.');
  const papers = [...records.values()];
  const counts = listingCounts(papers);
  const warnings = [...integrity];
  if (advertisedTotal === null) warnings.push('The daily total could not be verified.');
  else if (counts.total !== advertisedTotal) warnings.push('This page contains ' + counts.total + ' of ' + advertisedTotal + ' announced entries.');
  for (const [section, total] of Object.entries(sectionTotals)) {
    if (counts[section] !== total) warnings.push('The ' + section + ' section contains ' + counts[section] + ' of ' + total + ' entries.');
  }
  const complete = warnings.length === 0;
  return {
    population: 'today', papers, counts, announcementDate: date, announcementDates: date ? [date] : [], advertisedTotal, complete, warnings,
    nextUrls: complete ? [] : navigation(page, base), baseUrl: base,
    sectionTotals, integrityWarnings: [...integrity],
  };
}

// Recent is a source-defined collection of date cohorts, not a rolling clock
// window. Its advertised total counts rows; normalized paper IDs may repeat.
export function parseRecentListing(doc, baseUrl = 'https://arxiv.org/list/math/recent') {
  const page = doc.querySelector('#dlpage') || doc;
  const base = listingUrl(baseUrl, baseUrl);
  const integrity = new Set();
  if (!base || !new URL(base).pathname.endsWith('/recent')) {
    throw new Error('A valid arXiv Recent listing URL is required.');
  }
  const totals = new Set();
  for (const box of page.querySelectorAll('.paging, .pagination')) {
    const match = /\btotal\s+(?:of\s+)?([\d,]+)\s+(?:entr(?:y|ies)|articles?|items?)\b/i.exec(box.textContent);
    if (match) totals.add(Number(match[1].replace(/,/g, '')));
  }
  if (totals.size > 1) integrity.add('The pagination controls report conflicting entry totals.');
  const advertisedTotal = [...totals][0] ?? null;
  if (advertisedTotal !== null && (!Number.isSafeInteger(advertisedTotal) || advertisedTotal > 100000)) {
    integrity.add('The Recent entry total exceeds the supported collection limit.');
  }

  // Native date-navigation fragments identify the first row of every cohort.
  // These links freeze the complete date set even when the page shows 50 rows.
  const dateStarts = {};
  const declaredDates = [];
  for (const anchor of page.querySelectorAll('ul a[href], ol a[href]')) {
    if (anchor.closest('dt,dd')) continue;
    const date = parseDateHeading(anchor.textContent);
    const raw = anchor.getAttribute('href');
    if (!date || !listingUrl(raw, base)) continue;
    const match = /^#item([1-9]\d*)$/.exec(new URL(raw, base).hash);
    if (!match) continue;
    const start = Number(match[1]);
    if (!Number.isSafeInteger(start) || (advertisedTotal !== null && start > advertisedTotal)) {
      integrity.add('A Recent date-navigation row is outside the advertised population.');
      continue;
    }
    if (date in dateStarts && dateStarts[date] !== start) integrity.add('Conflicting first rows for the ' + date + ' cohort.');
    if (!(date in dateStarts)) declaredDates.push(date);
    dateStarts[date] = start;
  }
  const dateTotals = {};
  if (declaredDates.length) {
    if (dateStarts[declaredDates[0]] !== 1) integrity.add('Recent date navigation does not begin with the first entry.');
    for (let i = 0; i < declaredDates.length; i++) {
      const date = declaredDates[i], next = declaredDates[i + 1];
      if (next && (next >= date || dateStarts[next] <= dateStarts[date])) {
        integrity.add('Recent date navigation is not in chronological listing order.');
      }
      const end = next ? dateStarts[next] : advertisedTotal === null ? null : advertisedTotal + 1;
      if (end !== null) dateTotals[date] = end - dateStarts[date];
    }
  }
  const records = new Map();
  const positions = new Map();
  const claims = [];
  const observedDates = [];
  let currentDate = null, currentSection = null, currentClaim = null;
  let offset = Number(new URL(base).searchParams.get('skip') || 0);
  let rows = 0, malformed = 0, brokenPairs = 0, missingSubjects = 0, undated = 0;
  for (const node of page.querySelectorAll('h2,h3,h4,dt,dd')) {
    const list = node.closest(LISTS);
    if (/^H[234]$/.test(node.tagName)) {
      if (node.closest('dt,dd')) continue;
      const label = node.textContent.trim();
      const date = parseDateHeading(label);
      if (date) {
        currentDate = date;
        currentSection = null;
        if (!observedDates.includes(date)) observedDates.push(date);
        if (declaredDates.length && !declaredDates.includes(date)) integrity.add('A displayed cohort is absent from Recent date navigation.');
        const claim = countClaim(label);
        currentClaim = {date, ...claim, rows: 0};
        claims.push(currentClaim);
        if (Number.isSafeInteger(claim?.total)) {
          if (date in dateTotals && dateTotals[date] !== claim.total) integrity.add('Conflicting totals for the ' + date + ' announcement cohort.');
          dateTotals[date] = claim.total;
        }
      } else {
        const section = sectionHeading(label);
        if (section) currentSection = section;
      }
      continue;
    }
    if (!list || node.parentElement !== list) continue;
    if (node.localName === 'dd') {
      if (node.previousElementSibling?.localName !== 'dt') brokenPairs++;
      continue;
    }
    rows++;
    if (currentClaim) currentClaim.rows++;
    const dd = node.nextElementSibling;
    if (dd?.localName !== 'dd') { brokenPairs++; continue; }
    if (!currentDate) { undated++; continue; }
    const route = rowIdentity(node, base);
    if (!route) { malformed++; continue; }
    // Recent frequently has no explicit new/cross/replacement label. Keep null;
    // neither the primary category nor a version number proves submission type.
    const marker = node.querySelector('.list-identifier, .list-submission-type, [data-submission-type]');
    const rawSection = marker?.getAttribute('data-submission-type') || marker?.textContent || '';
    const section = sectionHeading(rawSection.trim()) || currentSection;
    const paper = parseRow(node, dd, route, section, currentDate, base);
    if (!paper.title) { malformed++; continue; }
    if (!paper.categories.length) missingSubjects++;
    const named = node.querySelector('a[name^="item"], a[id^="item"]');
    const match = /^item([1-9]\d*)$/.exec(named?.getAttribute('name') || named?.id || '');
    const index = match ? Number(match[1]) : offset + rows;
    if (index !== offset + rows || !Number.isSafeInteger(index) || (advertisedTotal !== null && index > advertisedTotal)) {
      integrity.add('A Recent row position disagrees with its pagination offset.');
    }
    if (positions.has(index)) integrity.add('A Recent row position is repeated within this page.');
    positions.set(index, {index, paperId: paper.id, announcementDate: currentDate, section: paper.section, version: paper.version});
    if (dateStarts[currentDate] && (index < dateStarts[currentDate] || index >= dateStarts[currentDate] + dateTotals[currentDate])) {
      integrity.add('A Recent row falls outside its advertised announcement cohort.');
    }
    const previous = records.get(paper.id);
    if (!previous) records.set(paper.id, paper);
    else if (previous.version === paper.version && previous.title !== paper.title) integrity.add('Conflicting metadata for arXiv:' + paper.id + '.');
  }
  if (!observedDates.length && advertisedTotal !== 0) integrity.add('The Recent listing does not identify valid announcement cohorts.');
  for (let i = 1; i < observedDates.length; i++) if (observedDates[i] >= observedDates[i - 1]) {
    integrity.add('The displayed Recent cohorts are not in chronological listing order.');
  }
  if (!page.querySelector(LISTS) && !page.querySelector('.paging,.pagination')) integrity.add('No arXiv article list or pagination summary was found.');
  if (brokenPairs) integrity.add('Unpaired paper headers or descriptions: ' + brokenPairs + '.');
  if (undated) integrity.add('Recent entries without an announcement date: ' + undated + '.');
  if (malformed) integrity.add('Entries without a valid arXiv identifier and title: ' + malformed + '.');
  if (missingSubjects) integrity.add('Entries without readable subject classifications: ' + missingSubjects + '.');
  for (const claim of claims) if (Number.isFinite(claim.shown) && (claim.shown !== claim.rows || claim.shown > claim.total)) {
    integrity.add('The displayed row count disagrees with the ' + claim.date + ' cohort heading.');
  }
  const papers = [...records.values()];
  const sourceEntries = [...positions.values()].sort((a, b) => a.index - b.index);
  const announcementDates = declaredDates.length ? declaredDates : observedDates;
  const warnings = [...integrity];
  if (advertisedTotal === null) warnings.push('The Recent total could not be verified.');
  else if (sourceEntries.length !== advertisedTotal || sourceEntries.some((entry, i) => entry.index !== i + 1)) {
    warnings.push('This page contains ' + sourceEntries.length + ' of ' + advertisedTotal + ' Recent entries.');
  }
  if (sourceEntries.length === advertisedTotal) {
    for (const [date, total] of Object.entries(dateTotals)) if (sourceEntries.filter(entry => entry.announcementDate === date).length !== total) {
      warnings.push('The complete row count disagrees with the ' + date + ' cohort total.');
    }
  }
  const complete = warnings.length === 0;
  return {
    population: 'recent', papers, counts: listingCounts(papers), announcementDate: null, announcementDates,
    advertisedTotal, entryCount: sourceEntries.length, distinctTotal: complete ? papers.length : null,
    sourceEntries, dateTotals, dateStarts, cohortSignature: declaredDates.length ? JSON.stringify(declaredDates.map(date => [date, dateStarts[date]])) : null,
    sectionTotals: {}, complete, warnings, integrityWarnings: [...integrity], baseUrl: base,
    nextUrls: complete ? [] : navigation(page, base),
  };
}

export function findPaperNodes(doc, baseUrl = doc.URL || DEFAULT_LIST) {
  const page = doc.querySelector('#dlpage') || doc;
  const base = arxivUrl(baseUrl, DEFAULT_LIST)?.href || DEFAULT_LIST;
  const result = new Map();
  for (const list of page.querySelectorAll(LISTS)) {
    for (const dt of list.querySelectorAll(':scope > dt')) {
      const identity = rowIdentity(dt, base);
      const dd = dt.nextElementSibling;
      if (identity && dd?.localName === 'dd' && !result.has(identity.id)) result.set(identity.id, { dt, dd });
    }
  }
  return result;
}

function metaValues(doc, name) {
  return [...doc.querySelectorAll('meta[name="' + name + '"]')]
    .map(meta => meta.getAttribute('content')?.trim()).filter(Boolean);
}

export function parseAbstract(doc, baseUrl = doc.URL) {
  const route = paperRoute(baseUrl, ORIGIN);
  if (!route || !['abs', 'html'].includes(route.format)) return null;
  const full = route.format === 'html';
  const root = full ? doc.querySelector('.ltx_document') : (doc.querySelector('#abs') || doc);
  if (!root) return null;
  const title = root.querySelector(full ? '.ltx_title_document, h1.ltx_title' : 'h1.title');
  const abstract = root.querySelector(full ? '.ltx_abstract' : 'blockquote.abstract, .abstract.mathjax');
  if (!title && !metaValues(doc, 'citation_title').length) return null;

  const candidates = [];
  if (full) candidates.push(route);
  // Cited articles in an abstract or bibliography never establish this paper's version.
  if (!full) {
    for (const anchor of doc.querySelectorAll('.arxivid a[href], .download-pdf, .full-text a[href], .full-text-links a[href], a[href*="/html/"]')) {
      if (anchor.closest('blockquote.abstract,.comments,.jref,.submission-history')) continue;
      candidates.push(paperRoute(anchor.getAttribute('href'), baseUrl));
    }
  }
  for (const url of metaValues(doc, 'citation_pdf_url')) candidates.push(paperRoute(url, baseUrl));
  const metadataId = paperId(metaValues(doc, 'citation_arxiv_id')[0]);
  const paper = {
    ...formats(route, candidates, metadataId?.id === route.id ? metadataId.version : 0),
    authors: full ? [] : readAuthors(root.querySelector('.authors'), baseUrl),
    ...readSubjects(root.querySelector('.tablecell.subjects, td.subjects, .list-subjects')),
    announcementDate: null, section: null,
  };
  readFields(paper, {
    title, abstract, comments: root.querySelector('td.comments, .list-comments'),
    journalRef: root.querySelector('td.jref, .list-journal-ref, .list-jref'),
  }, baseUrl);
  paper.title ||= metaValues(doc, 'citation_title')[0] || '';
  paper.abstract ||= metaValues(doc, 'citation_abstract')[0] || '';
  if (!paper.authors.length) {
    paper.authors = metaValues(doc, 'citation_author').map(name => ({ name, url: null, stableId: null }));
  }
  if (full && !paper.authors.length) {
    for (const person of root.querySelectorAll('.ltx_authors .ltx_personname, .ltx_creator.ltx_role_author .ltx_personname')) {
      const name = readField(person, baseUrl).text;
      const anchor = person.querySelector('a[href]') || person;
      if (name) paper.authors.push({ name, ...authorIdentity(anchor, baseUrl) });
    }
  }
  return paper.title ? paper : null;
}

export function readerTarget(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (!element || element.closest('nav,form,button,input,textarea,select,[contenteditable="true"],.ltx_page_navbar')) return null;
  return element.closest(
    '#dlpage dd .list-title, #dlpage dd p.mathjax, #dlpage dd .list-abstract, ' +
    '#abs h1.title, #abs blockquote.abstract, .ltx_document'
  );
}
