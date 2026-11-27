import { listingCounts, listingUrl, parseListing } from './parser.js';

const STATUS_BLOCKS_MORE_REQUESTS = new Set([401, 403, 429, 503]);

// The caller validates paper fields (checkedPaper) at its storage boundary.
// This validates the population envelope and recomputes completeness rather
// than trusting persisted counts or a persisted `complete: true` flag.
export function validatePopulationSnapshot(raw) {
  const fail = message => { throw new Error('Invalid population snapshot: ' + message + '.'); };
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const integer = (value, minimum=0) => Number.isSafeInteger(value) && value >= minimum && value <= 100000;
  const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value && value >= '1991-01-01';
  if (!plain(raw)) fail('object required');
  const baseUrl = listingUrl(raw.baseUrl, raw.baseUrl);
  const recent = baseUrl && new URL(baseUrl).pathname.endsWith('/recent');
  if (!baseUrl || raw.population !== (recent ? 'recent' : 'today')) fail('source identity');
  if (raw.complete !== true || !Array.isArray(raw.warnings) || raw.warnings.length ||
      !Array.isArray(raw.integrityWarnings) || raw.integrityWarnings.length ||
      !Array.isArray(raw.nextUrls) || raw.nextUrls.length) fail('unfinished population');
  if (!Array.isArray(raw.papers) || raw.papers.length > 100000 || !integer(raw.advertisedTotal)) fail('population size');
  const papers = new Map();
  for (const paper of raw.papers) {
    if (!plain(paper) || typeof paper.id !== 'string' || !paper.id || papers.has(paper.id) || !day(paper.announcementDate) ||
        ![null,'new','cross','replacement'].includes(paper.section) || !Number.isSafeInteger(paper.version) || paper.version < 0) fail('unique dated paper metadata');
    papers.set(paper.id,paper);
  }
  const counts = listingCounts(raw.papers);
  if (!plain(raw.counts) || Object.keys(counts).some(key=>raw.counts[key]!==counts[key])) fail('paper counts');
  if (!plain(raw.sectionTotals)) fail('section totals');
  for (const [section,count] of Object.entries(raw.sectionTotals)) {
    if (!['new','cross','replacement'].includes(section) || !integer(count) || (!recent && counts[section] !== count)) fail('section total');
  }
  if (!recent) {
    if (!day(raw.announcementDate) || counts.total !== raw.advertisedTotal ||
        raw.papers.some(p=>p.announcementDate!==raw.announcementDate || !p.section)) fail('Today announcement');
  } else {
    if (raw.announcementDate !== null || !Array.isArray(raw.announcementDates) || raw.announcementDates.length > 1000 ||
        raw.announcementDates.some((value,i)=>!day(value) || (i>0 && value>=raw.announcementDates[i-1]))) fail('Recent date cohorts');
    const dates = new Set(raw.announcementDates);
    if ((raw.advertisedTotal>0 && !dates.size) || raw.papers.some(p=>!dates.has(p.announcementDate))) fail('Recent paper cohort');
    if (!plain(raw.dateTotals) || !plain(raw.dateStarts) || Object.keys(raw.dateTotals).length !== dates.size) fail('Recent cohort totals');
    let total = 0;
    for (const [date,count] of Object.entries(raw.dateTotals)) {
      if (!dates.has(date) || !integer(count,1)) fail('Recent cohort total');
      total += count;
    }
    if (total !== raw.advertisedTotal) fail('Recent total');
    const starts = Object.keys(raw.dateStarts);
    if (starts.length) {
      if (starts.length !== dates.size) fail('Recent cohort starts');
      let start = 1;
      for (const date of raw.announcementDates) {
        if (raw.dateStarts[date] !== start) fail('Recent cohort position');
        start += raw.dateTotals[date];
      }
      if (raw.cohortSignature !== JSON.stringify(raw.announcementDates.map(date=>[date,raw.dateStarts[date]]))) fail('Recent cohort signature');
    } else if (raw.cohortSignature !== null) fail('Recent cohort signature');
    if (!Array.isArray(raw.sourceEntries) || raw.sourceEntries.length !== raw.advertisedTotal ||
        raw.entryCount !== raw.sourceEntries.length || raw.distinctTotal !== papers.size) fail('Recent source counts');
    const firstSeen = new Set();
    const cohortCounts = Object.fromEntries(raw.announcementDates.map(date=>[date,0]));
    for (let i=0;i<raw.sourceEntries.length;i++) {
      const entry=raw.sourceEntries[i], paper=papers.get(entry?.paperId);
      if (!plain(entry) || entry.index !== i+1 || !paper || !dates.has(entry.announcementDate) ||
          ![null,'new','cross','replacement'].includes(entry.section) || !Number.isSafeInteger(entry.version) || entry.version<0 ||
          (i>0 && entry.announcementDate>raw.sourceEntries[i-1].announcementDate)) fail('Recent source row');
      cohortCounts[entry.announcementDate]++;
      if (!firstSeen.has(entry.paperId)) {
        if (paper.announcementDate !== entry.announcementDate || paper.section !== entry.section ||
            (paper.version && entry.version && paper.version!==entry.version)) fail('Recent first paper occurrence');
        firstSeen.add(entry.paperId);
      }
    }
    if (firstSeen.size!==papers.size || raw.announcementDates.some(date=>cohortCounts[date]!==raw.dateTotals[date])) fail('Recent cohort row counts');
  }
  const result = mergeListingPages([{...raw,baseUrl}]);
  if (!result.complete) fail('population reconciliation');
  return result;
}

// The contents of a template belong to an inert document, including its images,
// frames and scripts. Only strings extracted by parseListing leave the template.
function inertDocument(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

export function mergeListingPages(pages) {
  if (!pages.length) throw new Error('A starting listing is required.');
  const first = pages[0];
  if (first.population === 'recent') return mergeRecentPages(pages);
  const papers = new Map();
  const totals = new Set();
  const sectionTotals = {};
  const integrity = new Set();
  const next = new Set();
  const visited = new Set();
  for (const page of pages) {
    if (!first.announcementDate || page.announcementDate !== first.announcementDate) {
      integrity.add('Pagination could not verify a single announcement date.');
      if (page !== first) continue;
    }
    if (!listingUrl(page.baseUrl, first.baseUrl)) {
      integrity.add('A pagination URL did not belong to the same arXiv daily listing.');
      continue;
    }
    visited.add(listingUrl(page.baseUrl, first.baseUrl));
    for (const warning of page.integrityWarnings || []) integrity.add(warning);
    if (Number.isSafeInteger(page.advertisedTotal)) totals.add(page.advertisedTotal);
    for (const [section, count] of Object.entries(page.sectionTotals || {})) {
      if (section in sectionTotals && sectionTotals[section] !== count) {
        integrity.add('The advertised size of the ' + section + ' section changed between pages.');
      }
      sectionTotals[section] = count;
    }
    for (const paper of page.papers) {
      const previous = papers.get(paper.id);
      if (previous && (previous.section !== paper.section || previous.title !== paper.title ||
          (previous.version && paper.version && previous.version !== paper.version))) {
        integrity.add('Different records were returned for arXiv:' + paper.id + '.');
      } else if (!previous || (!previous.version && paper.version)) {
        papers.set(paper.id, paper);
      }
    }
    for (const raw of page.nextUrls) {
      const url = listingUrl(raw, first.baseUrl);
      if (url) next.add(url);
    }
  }
  const advertisedTotal = [...totals][0] ?? null;
  if (totals.size > 1) integrity.add('The advertised daily total changed between pages.');
  const records = [...papers.values()];
  const counts = listingCounts(records);
  const warnings = [...integrity];
  if (advertisedTotal === null) warnings.push('The daily total could not be verified.');
  else if (counts.total !== advertisedTotal) warnings.push('Retrieved ' + counts.total + ' of ' + advertisedTotal + ' announced entries.');
  for (const [section, total] of Object.entries(sectionTotals)) {
    if (counts[section] !== total) warnings.push('Retrieved ' + counts[section] + ' of ' + total + ' entries in the ' + section + ' section.');
  }
  const complete = warnings.length === 0;
  return {
    population: 'today', papers: records, counts, advertisedTotal, sectionTotals, complete, warnings,
    announcementDates: first.announcementDate ? [first.announcementDate] : [],
    announcementDate: first.announcementDate, baseUrl: first.baseUrl, integrityWarnings: [...integrity],
    nextUrls: complete ? [] : [...next].filter(url => !visited.has(url)),
  };
}

// Reconcile raw row positions before deduplicating paper identities. Otherwise
// two page overlaps could conceal a missing cohort or falsely reduce coverage.
function mergeRecentPages(pages) {
  const first = pages[0], integrity = new Set(), totals = new Set();
  const positions = new Map(), records = new Map(), paperPositions = new Map();
  const dateTotals = {}, dateStarts = {}, visited = new Set(), next = new Set();
  const declared = new Set(first.announcementDates || []);
  for (const page of pages) {
    const url = listingUrl(page.baseUrl, first.baseUrl);
    if (page.population !== 'recent' || !url) {
      integrity.add('A pagination page did not belong to the same arXiv Recent listing.');
      continue;
    }
    if (page.cohortSignature !== first.cohortSignature) {
      integrity.add('The Recent announcement cohorts changed between pages.');
      if (page !== first) continue;
    }
    visited.add(url);
    for (const warning of page.integrityWarnings || []) integrity.add(warning);
    if (Number.isSafeInteger(page.advertisedTotal)) totals.add(page.advertisedTotal);
    for (const date of page.announcementDates || []) declared.add(date);
    for (const [name, values, target] of [['total', page.dateTotals || {}, dateTotals], ['first row', page.dateStarts || {}, dateStarts]]) {
      for (const [date, value] of Object.entries(values)) {
        if (date in target && target[date] !== value) integrity.add('The advertised ' + name + ' for the ' + date + ' cohort changed between pages.');
        target[date] = value;
      }
    }
    const pagePapers = new Map(page.papers.map(paper => [paper.id, paper]));
    for (const entry of page.sourceEntries || []) {
      const old = positions.get(entry.index);
      if (old && (old.paperId !== entry.paperId || old.announcementDate !== entry.announcementDate ||
          old.section !== entry.section || (old.version && entry.version && old.version !== entry.version))) {
        integrity.add('A Recent row changed identity, date, section or version between pages.');
        continue;
      }
      positions.set(entry.index, old || entry);
      const paper = pagePapers.get(entry.paperId), previous = records.get(entry.paperId);
      if (!paper) { integrity.add('A Recent source row has no matching paper metadata.'); continue; }
      if (previous && previous.version === paper.version && previous.title !== paper.title) {
        integrity.add('Conflicting metadata for arXiv:' + paper.id + '.');
      }
      if (!previous || entry.index < paperPositions.get(entry.paperId)) {
        records.set(entry.paperId, paper);
        paperPositions.set(entry.paperId, entry.index);
      } else if (entry.index === paperPositions.get(entry.paperId) && !previous.version && paper.version) {
        records.set(entry.paperId, paper);
      }
    }
    for (const raw of page.nextUrls || []) {
      const link = listingUrl(raw, first.baseUrl);
      if (link) next.add(link);
    }
  }
  if (totals.size > 1) integrity.add('The advertised Recent total changed between pages.');
  const advertisedTotal = [...totals][0] ?? null;
  const sourceEntries = [...positions.values()].sort((a, b) => a.index - b.index);
  const papers = [...records.values()].sort((a, b) => paperPositions.get(a.id) - paperPositions.get(b.id));
  const dates = [...declared].sort().reverse();
  for (let i = 1; i < sourceEntries.length; i++) {
    if (sourceEntries[i].announcementDate > sourceEntries[i - 1].announcementDate) integrity.add('Recent entries changed chronological cohort order.');
  }
  const warnings = [...integrity];
  if (advertisedTotal === null) warnings.push('The Recent total could not be verified.');
  else if (sourceEntries.length !== advertisedTotal || sourceEntries.some((entry, i) => entry.index !== i + 1)) {
    warnings.push('Retrieved ' + sourceEntries.length + ' of ' + advertisedTotal + ' Recent entries.');
  }
  for (const [date, total] of Object.entries(dateTotals)) {
    const received = sourceEntries.filter(entry => entry.announcementDate === date).length;
    if (received !== total) warnings.push('Retrieved ' + received + ' of ' + total + ' entries announced on ' + date + '.');
  }
  const complete = warnings.length === 0;
  const nextUrls = [...next].filter(url => {
    if (visited.has(url)) return false;
    const parsed = new URL(url), skip = Number(parsed.searchParams.get('skip') || 0), show = Number(parsed.searchParams.get('show') || 50);
    const end = advertisedTotal === null ? skip + show : Math.min(advertisedTotal, skip + show);
    for (let index = skip + 1; index <= end; index++) if (!positions.has(index)) return true;
    return false;
  }).sort((a, b) => {
    const left = new URL(a), right = new URL(b);
    return Number(right.searchParams.get('show') || 50) - Number(left.searchParams.get('show') || 50) ||
      Number(left.searchParams.get('skip') || 0) - Number(right.searchParams.get('skip') || 0);
  });
  return {
    population: 'recent', papers, counts: listingCounts(papers), advertisedTotal,
    announcementDate: null, announcementDates: dates, dateTotals, dateStarts,
    cohortSignature: first.cohortSignature, entryCount: sourceEntries.length,
    distinctTotal: complete ? papers.length : null, sourceEntries, sectionTotals: {}, complete, warnings,
    baseUrl: first.baseUrl, integrityWarnings: [...integrity], nextUrls: complete ? [] : nextUrls,
  };
}

export async function loadCompleteListing(initial, {
  request, parseDocument = inertDocument, baseUrl = initial.baseUrl, onProgress, maxPages = 80,
} = {}) {
  if (initial.complete) return initial;
  const start = listingUrl(baseUrl, baseUrl);
  const recent = initial.population === 'recent';
  if ((!recent && !initial.announcementDate) || (recent && !initial.announcementDates?.length && initial.advertisedTotal !== 0) || !start) {
    return { ...initial, complete: false, warnings: [...new Set([...initial.warnings, 'A dated arXiv daily listing is needed to retrieve additional pages.'])] };
  }
  const pages = [{ ...initial, baseUrl: start }];
  const attempted = new Set([start]);
  const errors = [];
  const retry = new Set();
  let combined = mergeListingPages(pages);
  let received = 0;
  while (!combined.complete && received < maxPages) {
    const next = combined.nextUrls.find(url => !attempted.has(url));
    if (!next) break;
    attempted.add(next);
    received++;
    let status = 0;
    try {
      const response = await request(next, { method: 'GET', timeout: 30000 });
      status = response?.status || 0;
      if (status < 200 || status >= 300) throw new Error('arXiv returned HTTP ' + status + '.');
      const finalUrl = listingUrl(response.finalUrl || next, start);
      if (!finalUrl) throw new Error('A redirect left the requested arXiv daily listing.');
      if (typeof response.text !== 'string' || response.text.length > 32 * 1024 * 1024) {
        throw new Error('The response was missing or exceeded the 32 MiB page limit.');
      }
      const page = parseListing(parseDocument(response.text, finalUrl), finalUrl);
      if (recent ? page.population !== 'recent' || page.cohortSignature !== initial.cohortSignature : !page.announcementDate || page.announcementDate !== initial.announcementDate) {
        errors.push('The announcement date changed or disappeared during pagination. Open the latest listing to start a new cycle.');
        break;
      }
      if (initial.advertisedTotal !== null && page.advertisedTotal !== null && page.advertisedTotal !== initial.advertisedTotal) {
        errors.push('The advertised daily total changed during pagination. Reload the listing to verify the new total.');
        break;
      }
      attempted.add(finalUrl);
      if (recent && Object.entries(initial.dateTotals || {}).some(([date, total]) => date in (page.dateTotals || {}) && page.dateTotals[date] !== total)) {
        errors.push('The Recent announcement cohort totals changed during pagination. Reload the listing.');
        break;
      }
      // A verified complete rendering can replace a truncated or malformed first
      // page. Never mix its metadata with a different publication cycle.
      if (page.complete && (!recent || mergeListingPages([...pages, page]).complete)) {
        onProgress?.({ pages: pages.length + 1, papers: page.counts.total, advertisedTotal: page.advertisedTotal });
        return page;
      }
      pages.push(page);
      combined = mergeListingPages(pages);
      onProgress?.({ pages: pages.length, papers: combined.counts.total, advertisedTotal: combined.advertisedTotal });
      if (recent && combined.integrityWarnings.length) break;
    } catch (error) {
      retry.add(next);
      errors.push('Could not read a pagination page. ' + (error?.message || 'The request failed.'));
      if (STATUS_BLOCKS_MORE_REQUESTS.has(status)) break;
    }
  }
  if (combined.complete) return combined;
  if (received >= maxPages && combined.nextUrls.some(url => !attempted.has(url))) {
    errors.push('Stopped after ' + received + ' additional pages. A complete listing could not be verified.');
  }
  if (!combined.nextUrls.length && !errors.length) errors.push('No further same-list pagination links were available.');
  return {
    ...combined, warnings: [...new Set([...combined.warnings, ...errors])],
    nextUrls: [...new Set([...combined.nextUrls.filter(url => !attempted.has(url)), ...retry])],
  };
}
