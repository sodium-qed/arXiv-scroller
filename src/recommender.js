import { CATEGORIES, normalizeCategory } from './categories.js';

// Coordinates shared by synonymous mathematical expressions. Other topics still
// receive their own token and phrase coordinates, learned directly from ratings.
const SEMANTIC_CONCEPTS = [
  ['elementary inequalities', /\b(?:elementary|algebraic|symmetric) inequalit(?:y|ies)\b|\b(?:am gm|arithmetic geometric mean|cauchy schwarz|schwarz inequality|holder inequality|jensen.{0,3} inequality)\b/],
  ['arithmetic–geometric mean inequality', /\bam gm\b|\barithmetic (?:mean )?geometric mean\b/],
  ['Cauchy–Schwarz inequality', /\bcauchy schwarz\b|\bschwarz inequality\b/],
  ['convexity', /\bconvex(?:ity|ification| sets?| functions?| bodies| geometry| optimization| analysis)\b|\bjensen.{0,3} inequality\b/],
  ['fixed-point methods', /\bfixed points?\b|\bcontraction (?:mapping|principle)\b/],
  ['ordinary differential equations', /\bordinary differential equations?\b|\bodes?\b/],
  ['partial differential equations', /\bpartial differential equations?\b|\bpdes?\b/],
  ['Fourier analysis', /\bfourier\b|\bharmonic analysis\b|\btrigonometric (?:series|polynomial)/],
  ['wavelets', /\bwavelets?\b|\bmultiresolution analysis\b/],
  ['Sobolev spaces', /\bsobolev\b|\bweak derivatives?\b/],
  ['fluid equations', /\bnavier stokes\b|\beuler equations?\b|\bfluid (?:dynamics|mechanics|equations?)\b/],
  ['optimal transport', /\boptimal (?:mass )?transport(?:ation)?\b|\bwasserstein\b|\bmonge kantorovich\b/],
  ['calculus of variations', /\bcalculus of variations\b|\bvariational (?:method|principle|problem)|\beuler lagrange\b/],
  ['finite element methods', /\bfinite elements?\b|\bgalerkin\b/],
  ['spectral methods', /\bspectral (?:methods?|collocation|approximation)\b|\bpseudospectral\b/],
  ['iterative linear solvers', /\bkrylov\b|\bconjugate gradient\b|\bgmres\b|\biterative linear solvers?\b/],
  ['gradient optimization', /\bgradient (?:descent|flows?|methods?)\b|\bsteepest descent\b/],
  ['integer optimization', /\binteger (?:linear )?(?:programming|optimization)\b|\bmixed integer\b/],
  ['elliptic curves', /\belliptic curves?\b|\bmordell weil\b|\bweierstrass equations?\b/],
  ['modular forms', /\b(?:modular|automorphic|cusp) forms?\b|\bhecke (?:operator|algebra)/],
  ['prime numbers', /\bprime (?:numbers?|gaps?|tuples?|distribution)\b|\bprimes\b|\briemann hypothesis\b/],
  ['Diophantine equations', /\bdiophantine\b|\binteger solutions?\b/],
  ['Galois theory', /\bgalois\b|\bfield extensions?\b/],
  ['lattice point counting', /\blattice points?\b|\behrhart\b/],
  ['algebraic varieties', /\balgebraic variet(?:y|ies)\b|\bprojective variet(?:y|ies)\b|\baffine variet(?:y|ies)\b/],
  ['Gröbner bases', /\bgro(?:e)?bner\b|\bbuchberger\b/],
  ['commutative ideals', /\bmonomial ideals?\b|\bprime ideals?\b|\bprimary decomposition\b/],
  ['derived categories', /\bderived (?:categor|functor)|\btriangulated categor/],
  ['homological algebra', /\b(?:co)?homolog(?:y|ical)\b|\bexact sequences?\b|\bext (?:group|functor)/],
  ['sheaf theory', /\bshea(?:f|ves)\b|\bpreshea(?:f|ves)\b/],
  ['category theory', /\bfunctor(?:s|ial)?\b|\bnatural transformations?\b|\bmonoidal categor|\bcategory theory\b/],
  ['K-theory', /\bk theory\b|\bgrothendieck groups?\b/],
  ['homotopy theory', /\bhomotop(?:y|ic|ical)\b|\bfundamental groups?\b/],
  ['knot theory', /\bknots?\b|\bkhovanov\b|\bjones polynomials?\b/],
  ['symplectic geometry', /\bsymplectic\b|\blagrangian (?:submanifold|fibration)|\bfloer\b/],
  ['Riemannian geometry', /\briemannian\b|\bricci\b|\bgeodesics?\b|\bsectional curvature\b/],
  ['metric geometry', /\bmetric spaces?\b|\bgromov hausdorff\b|\bgeodesic metric\b/],
  ['complex analysis', /\bholomorphic\b|\bmeromorphic\b|\bcomplex analys(?:is|tic)\b/],
  ['dynamical systems', /\bdynamical systems?\b|\bergodic\b|\bsymbolic dynamics\b/],
  ['graph coloring', /\b(?:vertex|edge|graph|list) colou?ring\b|\bchromatic (?:number|polynomial|index)\b/],
  ['graph matchings', /\b(?:perfect|bipartite|maximum|graph) matchings?\b|\bhall.{0,3} (?:theorem|condition)\b/],
  ['graphs and networks', /\bgraphs?\b|\bnetwork theory\b|\bgraphon/],
  ['extremal combinatorics', /\bextremal (?:graphs?|combinatorics)\b|\bturan\b|\bramsey\b/],
  ['generating functions', /\bgenerating (?:functions?|series)\b|\bformal power series\b/],
  ['combinatorial designs', /\b(?:block|combinatorial) designs?\b|\bsteiner systems?\b/],
  ['group representations', /\brepresentation(?:s| theory) of (?:a |the )?(?:finite |lie )?groups?\b|\bgroup representations?\b|\bcharacters? of (?:a |the )?groups?\b/],
  ['Lie algebras', /\blie (?:algebras?|brackets?|groups?)\b|\broot systems?\b/],
  ['quantum groups', /\bquantum groups?\b|\bhopf algebras?\b/],
  ['operator algebras', /\boperator algebras?\b|\bvon neumann algebras?\b|\bc (?:star )?algebras?\b/],
  ['spectral theory', /\bspectral theor(?:y|em)\b|\beigen(?:values?|functions?|vectors?)\b|\bspectra of\b/],
  ['Banach spaces', /\bbanach\b|\bnormed (?:linear |vector )?spaces?\b/],
  ['Hilbert spaces', /\bhilbert spaces?\b|\binner product spaces?\b/],
  ['probabilistic methods', /\bprobabilistic methods?\b|\bsecond moment methods?\b|\bfirst moment methods?\b/],
  ['random matrices', /\brandom matri(?:x|ces)\b|\bwigner (?:matrix|matrices|ensemble)\b/],
  ['stochastic processes', /\bstochastic processes?\b|\bbrownian\b|\bwiener process|\bmartingales?\b/],
  ['Markov chains', /\bmarkov (?:chains?|process(?:es)?)\b|\brandom walks?\b/],
  ['concentration inequalities', /\bconcentration (?:of measure|inequalit(?:y|ies))\b|\bchernoff\b|\bhoeffding\b/],
  ['Bayesian inference', /\bbayes(?:ian)?\b|\bposterior (?:distribution|inference)/],
  ['statistical estimation', /\b(?:maximum likelihood|minimax estimation|statistical estimat(?:ion|ors?))\b/],
  ['information and coding', /\bmutual information\b|\bchannel capacity\b|\bshannon\b|\berror correct(?:ing|ion) codes?\b/],
  ['set theory', /\bset theory\b|\bforcing (?:axiom|extension)|\blarge cardinals?\b/],
  ['model theory', /\bmodel theor(?:y|etic)\b|\bo minimal\b|\belementary equivalence\b/],
  ['proof theory', /\bproof theory\b|\bsequent calculus\b|\bcut elimination\b/],
  ['quantum mechanics', /\bquantum mechanics\b|\bschrodinger\b|\bhamiltonian (?:operator|systems?)\b/],
  ['persistent homology', /\bpersistent homology\b|\btopological data analysis\b/],
  ['machine learning', /\bmachine learning\b|\bneural networks?\b|\bdeep learning\b/],
];

const STOP = new Set(('a an and are as at be been being by can could did do does for from had has have ' +
  'he if in into is it its may more most new no not of on one or other our over paper previous prove ' +
  'proved proves proving provide provides recent result results show shown shows some such than that ' +
  'the their them then there these they this those through to two under upon us use used using various ' +
  'was we were when where which while will with within without work works also consider establish ' +
  'established obtain obtained study studying investigate introduce give given let mathrm mathbf mathcal ' +
  'mathbb operatorname left right frac begin end quad qquad text label ref cite').split(/\s+/));
const DAY = 86400000;
const EMBEDDING_SCHEMA = 'math-content-v1';
const cache = new WeakMap();

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function paperCategories(paper) {
  const raw = [paper?.primaryCategory, ...(Array.isArray(paper?.categories) ? paper.categories : [])];
  return [...new Set(raw.filter(code => typeof code === 'string').map(normalizeCategory)
    .filter(code => Object.hasOwn(CATEGORIES, code)))];
}

function plainMath(text) {
  return String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\\(?:text|mathrm|mathbf|mathcal|mathbb|operatorname)\s*\{([^{}]*)\}/g, ' $1 ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokens(text) {
  return text.split(/\s+/).filter(word => word.length >= 2 && word.length <= 45 &&
    /\p{L}/u.test(word) && !STOP.has(word));
}

function bump(map, key, by) {
  map.set(key, (map.get(key) || 0) + by);
}

function collectText(words, weight, singles, pairs) {
  for (let i = 0; i < words.length; i++) {
    bump(singles, words[i], weight);
    if (i > 0) bump(pairs, words[i - 1] + ' ' + words[i], weight);
  }
}

function addGroup(entries, prefix, counts, strength) {
  const features = [...counts].map(([key, value]) => [prefix + key, Math.log1p(value)]);
  const norm = Math.sqrt(features.reduce((sum, [, value]) => sum + value * value, 0));
  if (norm) for (const [key, value] of features) entries.push([key, strength * value / norm]);
}

function embedding(paper) {
  const title = String(paper?.title || '').slice(0, 2000);
  const abstract = String(paper?.abstract || '').slice(0, 16000);
  const categories = paperCategories(paper);
  const cached = paper && cache.get(paper);
  if (cached && cached.title === title && cached.abstract === abstract &&
      cached.categoryKey === categories.join('|')) return cached;

  const heading = plainMath(title);
  const body = plainMath(abstract);
  const titleWords = tokens(heading).slice(0, 96);
  const bodyWords = tokens(body).slice(0, 576);
  const singles = new Map();
  const pairs = new Map();
  const concepts = new Map();
  collectText(titleWords, 3, singles, pairs);
  collectText(bodyWords, 1, singles, pairs);
  for (const [term, pattern] of SEMANTIC_CONCEPTS) {
    const strength = (pattern.test(heading) ? 3 : 0) + (pattern.test(body) ? 1 : 0);
    if (strength) concepts.set(term, strength);
  }
  const terms = [...concepts.keys()];
  // Unknown mathematics stays discoverable through precise title phrases.
  if (!terms.length) {
    const titlePhrases = new Map();
    for (let i = 1; i < titleWords.length; i++) {
      const phrase = titleWords[i - 1] + ' ' + titleWords[i];
      if (!titlePhrases.has(phrase)) titlePhrases.set(phrase, pairs.get(phrase));
    }
    terms.push(...[...titlePhrases].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([term]) => term));
    if (!terms.length && titleWords.length) terms.push(titleWords[0]);
  }
  const entries = [];
  addGroup(entries, 'word:', singles, 1.35);
  addGroup(entries, 'phrase:', pairs, 0.95);
  addGroup(entries, 'concept:', concepts, 1.85);
  addGroup(entries, 'subject:', new Map(categories.map(code => [code, 1])), 0.45);
  const result = {title, abstract, categoryKey: categories.join('|'), terms, entries};
  if (paper && typeof paper === 'object') cache.set(paper, result);
  return result;
}

export function paperFeatures(paper) {
  return {schema: EMBEDDING_SCHEMA, entries: embedding(paper).entries.map(entry => [...entry])};
}

export function conceptTerms(paper) {
  return [...embedding(paper).terms];
}

function epoch(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return (value instanceof Date ? value : new Date(value)).getTime();
}

function dayOf(value) {
  const ms = epoch(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

function isoDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    dayOf(value) === value ? value : '';
}

function inRange(day, start, end) {
  return Boolean(day) && (!start || day >= start) && (!end || day <= end);
}

function latestFeedback(events) {
  const papers = new Map();
  for (const event of events || []) {
    if (typeof event?.paperId !== 'string' || !event.paperId) continue;
    if (!papers.has(event.paperId)) papers.set(event.paperId, []);
    papers.get(event.paperId).push(event);
  }
  const latest = [];
  for (const history of papers.values()) {
    const superseded = new Set(history.map(event => event.revisionOf).filter(Boolean));
    const tips = history.filter(event => !superseded.has(event.eventId));
    let chosen;
    let chosenTime = -Infinity;
    // For independent branches, choose the newest timestamp and break ties by
    // append order. A valid explicit revision also wins after a clock rollback.
    for (const event of tips.length ? tips : history) {
      const timestamp = epoch(event.timestamp);
      const time = Number.isFinite(timestamp) ? timestamp : -Infinity;
      if (time >= chosenTime) {
        chosen = event;
        chosenTime = time;
      }
    }
    latest.push(chosen);
  }
  return latest.sort((a, b) => (epoch(a.timestamp) || 0) - (epoch(b.timestamp) || 0));
}

function trainingEligible(event, settings, now) {
  const time = epoch(event.timestamp);
  if (!Number.isFinite(time) || !event.paper || typeof event.paper !== 'object' || event.excluded) return false;
  if (settings.trainRandom === false && event.mode === 'random') return false;
  if (time <= epoch(settings.resetAt)) return false;
  const history = settings.history || {};
  const day = dayOf(time);
  const start = isoDay(history.start);
  const end = isoDay(history.end);
  const days = Number.isFinite(Number(history.days)) ? Math.max(0, Number(history.days)) : 30;
  const cutoff = now - days * DAY;
  switch (history.mode) {
    case 'none': return false;
    case 'lastDays': return time >= cutoff && time <= now;
    case 'ignoreLastDays': return time < cutoff;
    case 'before': return !(start || end) || day >= (start || end);
    case 'after': return !(end || start) || day <= (end || start);
    case 'excludeRange': return !start || !end || !inRange(day, start < end ? start : end, start < end ? end : start);
    default: return true;
  }
}

export function activeFeedback(events, settings = {}, now = Date.now()) {
  const latest = latestFeedback(events);
  const active = [];
  const excluded = [];
  const clock = epoch(now);
  for (const event of latest) {
    if (event.value !== 'like' && event.value !== 'dislike') continue;
    (trainingEligible(event, settings, clock) ? active : excluded).push(event);
  }
  return {latest, active, excluded};
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, value))));
}

function fit(examples) {
  const index = new Map();
  let maxSquaredNorm = 1;
  const rows = examples.map(event => {
    const entries = embedding(event.paper).entries;
    const indices = new Uint32Array(entries.length);
    const values = new Float64Array(entries.length);
    let squaredNorm = 1;
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i];
      if (!index.has(key)) index.set(key, index.size);
      indices[i] = index.get(key);
      values[i] = value;
      squaredNorm += value * value;
    }
    maxSquaredNorm = Math.max(maxSquaredNorm, squaredNorm);
    return {indices, values, outcome: Number(event.value === 'like')};
  });
  const coefficients = new Float64Array(index.size);
  const gradient = new Float64Array(index.size);
  const weightPenalty = 0.22;
  const biasPenalty = 1.25;
  const step = 1 / (0.25 * maxSquaredNorm + biasPenalty);
  let bias = 0;
  for (let iteration = 0; iteration < 72; iteration++) {
    gradient.fill(0);
    let biasGradient = 0;
    for (const {indices, values, outcome} of rows) {
      let logit = bias;
      for (let i = 0; i < indices.length; i++) logit += coefficients[indices[i]] * values[i];
      const error = sigmoid(logit) - outcome;
      biasGradient += error;
      for (let i = 0; i < indices.length; i++) gradient[indices[i]] += error * values[i];
    }
    biasGradient = biasGradient / rows.length + biasPenalty * bias;
    bias -= step * biasGradient;
    let greatest = Math.abs(biasGradient);
    for (let i = 0; i < coefficients.length; i++) {
      const derivative = gradient[i] / rows.length + weightPenalty * coefficients[i];
      coefficients[i] -= step * derivative;
      greatest = Math.max(greatest, Math.abs(derivative));
    }
    if (greatest < 0.0001) break;
  }
  return {bias, weights: new Map([...index].map(([term, i]) => [term, coefficients[i]]))};
}

export function trainModel(events, settings = {}, now = Date.now()) {
  const {active} = activeFeedback(events, settings, now);
  const examples = [...active].sort((a, b) => compareText(a.paperId, b.paperId));
  const positiveCount = examples.filter(event => event.value === 'like').length;
  return {
    schema: EMBEDDING_SCHEMA,
    sampleCount: examples.length,
    positiveCount,
    negativeCount: examples.length - positiveCount,
    encounterPapers: examples.map(event => event.paper),
    ...(examples.length ? fit(examples) : {weights: new Map(), bias: 0}),
  };
}

export function predict(model, paper) {
  if (!model?.sampleCount || !(model.weights instanceof Map)) return null;
  let score = model.bias;
  for (const [feature, value] of embedding(paper).entries) score += (model.weights.get(feature) || 0) * value;
  return sigmoid(score);
}

export function interestEvidence(model, paper) {
  if (!model?.sampleCount) return null;
  let strongest = 0;
  let term = null;
  for (const [key, value] of embedding(paper).entries) {
    const contribution = (model.weights.get(key) || 0) * value;
    if (contribution > strongest && !key.startsWith('subject:')) {
      strongest = contribution;
      term = key.slice(key.indexOf(':') + 1);
    }
  }
  return term;
}

function authorName(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function stableAuthorId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  const orcid = /^(?:(?:https?:\/\/(?:www\.)?orcid\.org\/|orcid:)\s*)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\/?$/i.exec(id);
  if (orcid) return 'orcid:' + orcid[1].toUpperCase();
  const arxiv = /^(?:https?:\/\/(?:www\.)?arxiv\.org\/a\/|arxiv:)([a-zA-Z0-9_-]+)\/?$/.exec(id);
  if (arxiv) return 'arxiv:' + arxiv[1];
  return id;
}

export function authorIdentity(author) {
  const id = stableAuthorId(author?.stableId);
  const name = authorName(author?.name);
  return id ? 'id:' + id : name ? 'name:' + name : '';
}

export function subscriptionMatches(author, subscription) {
  if (!author || !subscription) return false;
  const authorId = stableAuthorId(author.stableId);
  const subscriptionId = stableAuthorId(subscription.stableId);
  if (authorId && subscriptionId) return authorId === subscriptionId;
  const name = authorName(subscription.name);
  return Boolean(subscription.confirmedNameOnly === true && name && name === authorName(author.name));
}

function observedInterval(positive, negative) {
  const n = positive + negative;
  if (n < 3) return {estimate: null, interval: null};
  const z = 1.95996398454;
  const share = positive / n;
  const denominator = 1 + z * z / n;
  const center = (share + z * z / (2 * n)) / denominator;
  const radius = z * Math.sqrt(share * (1 - share) / n + z * z / (4 * n * n)) / denominator;
  return {estimate: share, interval: [Math.max(0, center - radius), Math.min(1, center + radius)]};
}

function countedTerms(counts) {
  return [...counts].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])).map(([term, count]) => ({term, count}));
}

function glossaryCounts(glossary, start, end) {
  const terms = new Map();
  const names = new Map();
  for (const item of Object.values(glossary || {})) {
    if (!item?.term || typeof item.term !== 'string') continue;
    const key = item.term.normalize('NFKC').trim().toLowerCase();
    if (!key) continue;
    let count;
    if (!start && !end) {
      count = Math.max(0, Number(item.visits) || 0, item.visitHistory?.length || 0);
    } else if (Array.isArray(item.visitHistory)) {
      count = item.visitHistory.filter(value => inRange(dayOf(value), start, end)).length;
    } else {
      count = Number(item.visits > 0 && inRange(dayOf(item.lastVisitedAt || item.updatedAt), start, end));
    }
    if (count > 0) {
      bump(terms, key, count);
      if (!names.has(key)) names.set(key, item.term.trim());
    }
  }
  return countedTerms(terms).map(row => ({term: names.get(row.term), count: row.count}));
}

function knowledgeRows(profile, start, end) {
  const rows = [];
  for (const [term, item] of Object.entries(profile || {})) {
    if (!item?.level) continue;
    const changes = [...(Array.isArray(item.history) ? item.history : [])];
    if (!changes.some(change => change?.level === item.level && change.updatedAt === item.updatedAt)) {
      changes.push({level: item.level, updatedAt: item.updatedAt});
    }
    const history = changes.filter(change => change?.level && inRange(dayOf(change.updatedAt), start, end))
      .sort((a, b) => epoch(a.updatedAt) - epoch(b.updatedAt));
    if (history.length) rows.push({term, ...history.at(-1), history});
  }
  return rows.sort((a, b) => compareText(a.term, b.term));
}

export function analytics(state, {start: from = '', end: to = '', now = Date.now(), model: suppliedModel} = {}) {
  const start = isoDay(from);
  const end = isoDay(to);
  const {latest, active, excluded} = activeFeedback(state.events, state.settings, now);
  const within = timestamp => inRange(dayOf(timestamp), start, end);
  const model = suppliedModel || trainModel(state.events, state.settings, now);
  const papers = new Map(Object.entries(state.papers || {}));
  for (const event of latest) if (!papers.has(event.paperId) && event.paper) papers.set(event.paperId, event.paper);
  const categories = new Map(Object.entries(CATEGORIES).map(([code, name]) =>
    [code, {code, name, reviewed: 0, positive: 0, negative: 0, background: 0, predictionTotal: 0,
      predictionSamples: 0, activeSamples: 0}]));
  const reviewed = new Set();
  const months = new Map();
  const liked = new Map();
  const totals = {positive: 0, negative: 0, background: 0};

  function record(id, paper, timestamp, signal) {
    const month = dayOf(timestamp).slice(0, 7);
    if (!months.has(month)) months.set(month, {period: month, positive: 0, negative: 0, background: 0,
      ids: new Set(), categories: {}});
    const row = months.get(month);
    const codes = paperCategories(paper);
    if (signal) {
      totals[signal]++;
      row[signal]++;
    }
    for (const code of codes) {
      const category = categories.get(code);
      if (!reviewed.has(id)) category.reviewed++;
      if (!Object.hasOwn(row.categories, code)) row.categories[code] = {reviewed: 0, positive: 0, negative: 0, background: 0};
      if (!row.ids.has(id)) row.categories[code].reviewed++;
      if (signal) {
        category[signal]++;
        row.categories[code][signal]++;
      }
    }
    reviewed.add(id);
    row.ids.add(id);
  }

  for (const event of latest) {
    if (!within(event.timestamp) || !['like', 'dislike', 'neutral', 'background'].includes(event.value)) continue;
    const paper = event.paper || papers.get(event.paperId);
    const signal = {like: 'positive', dislike: 'negative', background: 'background'}[event.value];
    record(event.paperId, paper, event.timestamp, signal);
    if (event.value === 'like') for (const term of conceptTerms(paper)) bump(liked, term, 1);
  }
  for (const event of active) {
    if (within(event.timestamp)) for (const code of paperCategories(event.paper)) categories.get(code).activeSamples++;
  }
  const readingHistory = [];
  for (const [paperId, timestamp] of Object.entries(state.reading || {})) {
    if (!within(timestamp)) continue;
    const paper = papers.get(paperId) || null;
    readingHistory.push({paperId, timestamp, paper});
    record(paperId, paper, timestamp);
  }
  readingHistory.sort((a, b) => epoch(b.timestamp) - epoch(a.timestamp) || compareText(a.paperId, b.paperId));
  const datedPapers = [...papers.values()].filter(p => inRange(isoDay(p?.announcementDate), start, end));
  if (model.sampleCount >= 3 && model.positiveCount && model.negativeCount) {
    for (const paper of datedPapers) {
      const estimate = predict(model, paper);
      for (const code of paperCategories(paper)) {
        const row = categories.get(code);
        row.predictionTotal += estimate;
        row.predictionSamples++;
      }
    }
  }
  const followedResearchers = (state.subscriptions || []).map(subscription => {
    const recent = datedPapers.filter(paper => paper.authors?.some(author => subscriptionMatches(author, subscription)))
      .sort((a, b) => compareText(b.announcementDate, a.announcementDate) || compareText(a.id, b.id));
    return {...subscription, recent, unread: recent.filter(paper => !Object.hasOwn(state.reading || {}, paper.id))};
  });
  return {
    activeCount: active.filter(event => within(event.timestamp)).length,
    excludedCount: excluded.filter(event => within(event.timestamp)).length,
    modelSamples: model.sampleCount,
    reviewedCount: reviewed.size,
    positiveCount: totals.positive,
    negativeCount: totals.negative,
    backgroundCount: totals.background,
    categories: [...categories.values()].map(({predictionTotal, ...row}) => ({...row,
      ...observedInterval(row.positive, row.negative),
      prediction: row.predictionSamples ? predictionTotal / row.predictionSamples : null})),
    likedConcepts: countedTerms(liked),
    unfamiliarTerms: glossaryCounts(state.glossary, start, end),
    timeline: [...months.values()].sort((a, b) => compareText(a.period, b.period))
      .map(({ids, ...row}) => ({...row, reviewed: ids.size})),
    followedResearchers,
    readingHistory,
    knowledge: knowledgeRows(state.knowledge, start, end),
  };
}
