import { listingCounts, listingUrl, parseListing } from './parser.js';

const STATUS_BLOCKS_MORE_REQUESTS = new Set([401, 403, 429, 503]);

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
    papers: records, counts, advertisedTotal, sectionTotals, complete, warnings,
    announcementDate: first.announcementDate, baseUrl: first.baseUrl, integrityWarnings: [...integrity],
    nextUrls: complete ? [] : [...next].filter(url => !visited.has(url)),
  };
}

export async function loadCompleteListing(initial, {
  request, parseDocument = inertDocument, baseUrl = initial.baseUrl, onProgress, maxPages = 80,
} = {}) {
  if (initial.complete) return initial;
  const start = listingUrl(baseUrl, baseUrl);
  if (!initial.announcementDate || !start) {
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
      if (!page.announcementDate || page.announcementDate !== initial.announcementDate) {
        errors.push('The announcement date changed or disappeared during pagination. Open the latest listing to start a new cycle.');
        break;
      }
      if (initial.advertisedTotal !== null && page.advertisedTotal !== null && page.advertisedTotal !== initial.advertisedTotal) {
        errors.push('The advertised daily total changed during pagination. Reload the listing to verify the new total.');
        break;
      }
      attempted.add(finalUrl);
      // A verified complete rendering can replace a truncated or malformed first
      // page. Never mix its metadata with a different publication cycle.
      if (page.complete) {
        onProgress?.({ pages: pages.length + 1, papers: page.counts.total, advertisedTotal: page.advertisedTotal });
        return page;
      }
      pages.push(page);
      combined = mergeListingPages(pages);
      onProgress?.({ pages: pages.length, papers: combined.counts.total, advertisedTotal: combined.advertisedTotal });
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
