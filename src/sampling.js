import { CATEGORIES } from './categories.js';
import { authorIdentity, conceptTerms, interestEvidence, paperCategories, predict, subscriptionMatches } from './recommender.js';

const MODES = new Set(['random', 'balanced', 'personalized', 'discovery', 'subscriptions', 'original']);
const CODES = Object.keys(CATEGORIES).sort();

function compareIds(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function randomSource(seed) {
  let state = 2166136261;
  for (const char of String(seed)) state = Math.imul(state ^ char.codePointAt(0), 16777619) >>> 0;
  function uint32() {
    state = (state + 0x6D2B79F5) >>> 0;
    let bits = Math.imul(state ^ (state >>> 15), state | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return (bits ^ (bits >>> 14)) >>> 0;
  }
  return {
    // Rejection avoids modulo bias in bounded integer draws for Fisher–Yates.
    index(bound) {
      const limit = Math.floor(4294967296 / bound) * bound;
      let value;
      do { value = uint32(); } while (value >= limit);
      return value % bound;
    },
    unit() { return (uint32() + 0.5) / 4294967296; },
  };
}

function shuffled(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = random.index(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function eligibleSection(section, settings) {
  return section === 'new' || (section === 'cross' && settings.includeCross === true) ||
    (section === 'replacement' && settings.includeReplacements === true);
}

function optionsFor(papers, options) {
  const settings = options.settings || {};
  const requested = options.mode || settings.mode;
  const mode = MODES.has(requested) ? requested : 'random';
  const date = options.date || '';
  const seed = options.seed ?? (date + '|' + mode);
  const byId = new Map();
  const availableSections = new Map(CODES.map(code => [code, new Set()]));
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) for (const paper of papers || []) {
    if (!paper || typeof paper.id !== 'string' || !paper.id || paper.announcementDate !== date) continue;
    const codes = paperCategories(paper);
    for (const code of codes) availableSections.get(code).add(paper.section);
    if (!codes.length || !eligibleSection(paper.section, settings)) continue;
    const previous = byId.get(paper.id);
    if (!previous) {
      byId.set(paper.id, paper);
    } else {
      const chosen = (Number(paper.version) || 0) > (Number(previous.version) || 0) ? paper : previous;
      byId.set(paper.id, {...chosen, categories: [...new Set([...codes, ...paperCategories(previous)])]});
    }
  }
  const pool = [...byId.values()].sort(compareIds);
  const categories = new Map(pool.map(paper => [paper.id, paperCategories(paper)]));
  const byCategory = new Map(CODES.map(code => [code, []]));
  for (const paper of pool) for (const code of categories.get(paper.id)) byCategory.get(code).push(paper);
  const subscriptionCache = new Map();
  function matches(paper) {
    if (!subscriptionCache.has(paper.id)) {
      const found = [];
      for (const subscription of options.subscriptions || []) {
        const author = paper.authors?.find(person => subscriptionMatches(person, subscription));
        if (author) found.push({name: subscription.name || author.name, nameOnly: !(author.stableId && subscription.stableId)});
      }
      subscriptionCache.set(paper.id, found);
    }
    return subscriptionCache.get(paper.id);
  }
  const useSubscriptions = settings.useSubscriptions === true && (mode === 'balanced' || mode === 'personalized');
  const hasPreference = (mode === 'balanced' || mode === 'personalized') &&
    Boolean(options.model?.sampleCount || (useSubscriptions && pool.some(paper => matches(paper).length)));
  const exploration = Number(settings.exploration ?? 0.25);
  const count = Number(settings.personalizedCount ?? 32);
  return {
    date, mode, seed, model: options.model, random: randomSource(seed), pool, byId, categories, byCategory,
    availableSections, matches, useSubscriptions, hasPreference, info: new Map(),
    exploration: Number.isFinite(exploration) ? Math.max(0, Math.min(1, exploration)) : 0.25,
    count: Number.isFinite(count) ? Math.max(1, Math.min(32, Math.trunc(count))) : 32,
    encounters: mode === 'discovery' ? encountered(options, byId) : null,
    incomplete: options.complete === false,
  };
}

function encountered(options, candidates) {
  const ids = new Set();
  const history = new Map();
  for (const paper of options.model?.encounterPapers || []) if (paper?.id) history.set(paper.id, paper);
  for (const id of Object.keys(options.reading || {})) {
    ids.add(id);
    const known = options.knownPapers instanceof Map ? options.knownPapers.get(id) :
      Object.hasOwn(options.knownPapers || {}, id) ? options.knownPapers[id] : null;
    if (known || candidates.has(id)) history.set(id, known || candidates.get(id));
  }
  const subjects = new Map();
  const topics = new Map();
  const authors = new Map();
  function count(keys, target) {
    for (const key of new Set(keys)) if (key) target.set(key, (target.get(key) || 0) + 1);
  }
  for (const [id, paper] of history) {
    ids.add(id);
    count(paperCategories(paper), subjects);
    count(conceptTerms(paper), topics);
    count((paper.authors || []).map(authorIdentity), authors);
  }
  return {ids, subjects, topics, authors};
}

function novelty(paper, ctx) {
  const known = ctx.encounters;
  const topicLabels = conceptTerms(paper);
  const authorLabels = [...new Set((paper.authors || []).map(authorIdentity).filter(Boolean))];
  const groups = [
    [ctx.categories.get(paper.id), known.subjects, 0.2],
    [topicLabels, known.topics, 0.48],
    [authorLabels, known.authors, 0.32],
  ];
  let total = 0;
  let denominator = 0;
  for (const [labels, counts, importance] of groups) {
    if (!labels.length) continue;
    total += importance * labels.reduce((n, label) => n + 1 / Math.sqrt(1 + (counts.get(label) || 0)), 0) / labels.length;
    denominator += importance;
  }
  const score = total / (denominator || 1) - (known.ids.has(paper.id) ? 0.6 : 0);
  return {weight: Math.exp(4.5 * score), totalTopics: topicLabels.length,
    newTopics: topicLabels.filter(term => !known.topics.has(term)).length,
    totalAuthors: authorLabels.length, newAuthors: authorLabels.filter(id => !known.authors.has(id)).length};
}

function paperInfo(paper, ctx) {
  if (ctx.info.has(paper.id)) return ctx.info.get(paper.id);
  let detail = {weight: 1};
  if (ctx.mode === 'discovery' && ctx.encounters.ids.size) {
    detail = novelty(paper, ctx);
  } else if (ctx.hasPreference) {
    const prediction = predict(ctx.model, paper);
    const followed = ctx.useSubscriptions && ctx.matches(paper).length > 0;
    detail = {prediction, followed, weight: Math.exp(5 * ((prediction ?? 0.5) - 0.5)) * (followed ? 2 : 1)};
  }
  ctx.info.set(paper.id, detail);
  return detail;
}

function rankPool(items, ctx) {
  const n = items.length;
  const weights = items.map(paper => paperInfo(paper, ctx).weight);
  const equal = weights.every(weight => weight === weights[0]);
  const explore = ctx.mode === 'balanced' ? ctx.exploration : 0;
  const sum = weights.reduce((a, b) => a + b, 0);
  const flat = equal || explore === 1;
  const first = new Map(items.map((paper, i) => [paper.id, flat ? 1 / n : explore / n + (1 - explore) * weights[i] / sum]));
  const exploreBranch = explore === 1 || (!equal && explore > 0 && ctx.random.unit() < explore);
  let order;
  if (equal || exploreBranch) {
    order = shuffled(items, ctx.random);
  } else {
    // Independent exponential clocks generate a weighted permutation without replacement.
    order = items.map((paper, i) => ({paper, key: -Math.log(ctx.random.unit()) / weights[i]}))
      .sort((a, b) => a.key - b.key || compareIds(a.paper, b.paper)).map(item => item.paper);
  }
  return {order, first, flat, exploreBranch, count: n};
}

function describe(paper, category, ranking, ctx) {
  const where = category ? ' for ' + category : '';
  if (ctx.mode === 'random') {
    return 'Uniform random priorities' + where + ' among ' + ranking.count +
      ' eligible paper(s). Cross-listed papers are assigned to maximize distinct category coverage.';
  }
  if (ctx.mode === 'discovery') {
    if (!ctx.encounters.ids.size) return 'First discovery draw' + where + '. All eligible papers received uniform priorities.';
    const info = paperInfo(paper, ctx);
    return 'Discovery draw' + where + ' weighted by prior topic, category and author encounters. ' +
      info.newTopics + ' of ' + info.totalTopics + ' topic labels and ' + info.newAuthors + ' of ' +
      info.totalAuthors + ' author IDs or names were unseen.';
  }
  if (!ctx.hasPreference) return 'Cold-start draw' + where + '. Eligible papers received uniform priorities.';
  if (ctx.mode === 'balanced' && ranking.exploreBranch) return 'Uniform exploration draw' + where +
    ' among ' + ranking.count + ' eligible paper(s). Cross-listed papers are assigned to maximize coverage.';
  const info = paperInfo(paper, ctx);
  let text = (ctx.mode === 'personalized' ? 'Personalized draw' : 'Within-category draw') + where + '.';
  if (ctx.model?.sampleCount) {
    text += ' Weights use a local model trained on ' + ctx.model.sampleCount + ' active rating(s).';
    const term = interestEvidence(ctx.model, paper);
    if (term) text += ' Its strongest positive text association was “' + term + '”.';
  }
  if (info.followed) text += ' A followed-author match also increased its weight.';
  if (ctx.model?.sampleCount > 0 && ctx.model.sampleCount < 10) text += ' The training sample is small.';
  return text;
}

function matchedEntry(paper, code, ranking, ctx, probability) {
  return {paperId: paper.id, category: code, reason: describe(paper, code, ranking, ctx), probability};
}

function augment(code, visited, rankings, byPaper, byCategory) {
  for (const paper of rankings.get(code).order) {
    if (visited.has(paper.id)) continue;
    visited.add(paper.id);
    const previous = byPaper.get(paper.id);
    if (previous === undefined || augment(previous, visited, rankings, byPaper, byCategory)) {
      byPaper.set(paper.id, code);
      byCategory.set(code, paper);
      return true;
    }
  }
  return false;
}

function missingReason(code, ctx) {
  const candidates = ctx.byCategory.get(code);
  if (candidates.length) return 'All ' + candidates.length +
    ' eligible paper(s) represent other categories in this maximum-coverage matching.';
  const sections = ctx.availableSections.get(code);
  const disabled = [];
  if (sections.has('cross')) disabled.push('cross-submissions');
  if (sections.has('replacement')) disabled.push('replacements');
  if (disabled.length) return 'Only ' + disabled.join(' and ') + ' were found for this date. Their sections are disabled.';
  if (ctx.incomplete) return 'No eligible paper was found in the loaded part of this announcement.';
  return 'No eligible paper was found for this category on the announcement date.';
}

function categorySelection(ctx) {
  const rankings = new Map(CODES.map(code => [code, rankPool(ctx.byCategory.get(code), ctx)]));
  const order = shuffled(CODES.filter(code => rankings.get(code).count), ctx.random);
  const byPaper = new Map();
  const byCategory = new Map();
  for (const code of order) augment(code, new Set(), rankings, byPaper, byCategory);
  const entries = [];
  for (const code of order) {
    const paper = byCategory.get(code);
    if (!paper) continue;
    const ranking = rankings.get(code);
    const isolated = ctx.byCategory.get(code).every(candidate => ctx.categories.get(candidate.id).length === 1);
    // Matching changes the inclusion probabilities of overlapping candidates.
    entries.push(matchedEntry(paper, code, ranking, ctx, isolated ? ranking.first.get(paper.id) : null));
  }
  const missing = CODES.filter(code => !byCategory.has(code)).map(category =>
    ({category, reason: missingReason(category, ctx)}));
  return {entries, missing};
}

function coldPersonalized(ctx, count) {
  const base = categorySelection(ctx).entries;
  const initialCount = base.length;
  const assigned = new Set(base.map(entry => entry.paperId));
  let entries;
  if (count < initialCount) {
    entries = shuffled(base, ctx.random).slice(0, count);
  } else {
    const extra = shuffled(ctx.pool.filter(paper => !assigned.has(paper.id)), ctx.random).slice(0, count - initialCount);
    entries = [...base, ...extra.map(paper => ({paperId: paper.id, category: null, probability: null,
      reason: 'Uniform cold-start draw from the remaining papers after the available categories were represented.'}))];
  }
  return entries.map(entry => {
    let probability = null;
    if (count === ctx.pool.length) {
      probability = 1;
    } else {
      const [code, ...otherCodes] = ctx.categories.get(entry.paperId);
      const candidates = ctx.byCategory.get(code);
      if (!otherCodes.length && candidates.every(paper => ctx.categories.get(paper.id).length === 1)) {
        const initial = 1 / candidates.length;
        probability = count <= initialCount ? initial * count / initialCount :
          initial + (1 - initial) * (count - initialCount) / (ctx.pool.length - initialCount);
      }
    }
    return {...entry, probability};
  });
}

function personalized(ctx) {
  const count = Math.min(ctx.count, ctx.pool.length);
  if (!ctx.hasPreference) return coldPersonalized(ctx, count);
  const ranking = rankPool(ctx.pool, ctx);
  return ranking.order.slice(0, count).map(paper => {
    let probability = null;
    if (count === ctx.pool.length) probability = 1;
    else if (ranking.flat) probability = count / ctx.pool.length;
    else if (count === 1) probability = ranking.first.get(paper.id);
    return matchedEntry(paper, null, ranking, ctx, probability);
  });
}

function followedEntry(paper, ctx) {
  const names = ctx.matches(paper).map(match => match.name + (match.nameOnly ? ' (confirmed name-only match)' : ' (stable ID)'));
  return {paperId: paper.id, category: null, probability: 1, reason: 'Matches your subscription to ' + names.join(', ') + '.'};
}

export function generateSelection(papers, options = {}) {
  const ctx = optionsFor(papers, options);
  const result = {mode: ctx.mode, date: ctx.date, seed: ctx.seed, entries: [], missing: []};
  switch (ctx.mode) {
    case 'original': return result;
    case 'subscriptions': result.entries = ctx.pool.filter(paper => ctx.matches(paper).length).map(paper => followedEntry(paper, ctx)); break;
    case 'personalized': result.entries = personalized(ctx); break;
    default: Object.assign(result, categorySelection(ctx));
  }
  return result;
}

function crossListedReplacement(selection, paperId, target, ctx) {
  const rankings = new Map();
  const byPaper = new Map();
  const byCategory = new Map();
  for (const entry of selection.entries) {
    if (!ctx.byCategory.has(entry.category)) return null;
    if (entry.paperId !== paperId) {
      const paper = ctx.byId.get(entry.paperId);
      if (!paper || !ctx.categories.get(paper.id).includes(entry.category)) return null;
      byPaper.set(paper.id, entry.category);
      byCategory.set(entry.category, paper);
    }
  }
  const retained = new Set(byPaper.keys());
  for (const {category} of selection.entries) {
    const ranking = rankPool(ctx.byCategory.get(category).filter(paper => paper.id !== paperId), ctx);
    // Prefer ending a path at an unused paper to unnecessary reassignment.
    ranking.order = [...ranking.order.filter(paper => !retained.has(paper.id)), ...ranking.order.filter(paper => retained.has(paper.id))];
    rankings.set(category, ranking);
  }
  if (!augment(target.category, new Set(), rankings, byPaper, byCategory)) return null;
  const added = [...byPaper.keys()].find(id => !retained.has(id));
  if (!added) return null;
  return selection.entries.map(entry => {
    const id = entry.paperId === paperId ? added : entry.paperId;
    const code = byPaper.get(id);
    if (id === entry.paperId && code === entry.category) return entry;
    const updated = matchedEntry(ctx.byId.get(id), code, rankings.get(code), ctx, null);
    return {...updated, reason: 'A cross-list reassignment preserved the represented categories. ' + updated.reason};
  });
}

export function replaceSelectionPaper(selection, paperId, papers, options = {}) {
  const target = selection?.entries?.find(entry => entry.paperId === paperId);
  if (!target || selection.mode === 'original') return null;
  const ctx = optionsFor(papers, {...options, mode: selection.mode, date: selection.date,
    seed: options.seed ?? (String(selection.seed) + '|replace|' + paperId)});
  const selected = new Set(selection.entries.map(entry => entry.paperId));
  const quota = ['random', 'balanced', 'discovery'].includes(ctx.mode);
  const candidates = (quota ? ctx.byCategory.get(target.category) || [] : ctx.pool).filter(paper =>
    !selected.has(paper.id) && (ctx.mode !== 'subscriptions' || ctx.matches(paper).length));
  let entries;
  if (candidates.length) {
    const ranking = rankPool(candidates, ctx);
    const paper = ranking.order[0];
    const entry = ctx.mode === 'subscriptions' ? followedEntry(paper, ctx) :
      matchedEntry(paper, quota ? target.category : null, ranking, ctx, ranking.first.get(paper.id));
    if (ctx.mode === 'subscriptions') entry.probability = 1 / candidates.length;
    entries = selection.entries.map(old => old.paperId === paperId ? entry : old);
  } else if (quota) {
    entries = crossListedReplacement(selection, paperId, target, ctx);
  }
  return entries ? {...selection, entries, seed: ctx.seed} : null;
}
