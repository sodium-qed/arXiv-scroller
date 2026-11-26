// Mathematics-facing codes for the cross-archive equivalents in arXiv's taxonomy.
export const CATEGORIES = Object.freeze({
  'math.AC': 'Commutative Algebra',
  'math.AG': 'Algebraic Geometry',
  'math.AP': 'Analysis of PDEs',
  'math.AT': 'Algebraic Topology',
  'math.CA': 'Classical Analysis and ODEs',
  'math.CO': 'Combinatorics',
  'math.CT': 'Category Theory',
  'math.CV': 'Complex Variables',
  'math.DG': 'Differential Geometry',
  'math.DS': 'Dynamical Systems',
  'math.FA': 'Functional Analysis',
  'math.GM': 'General Mathematics',
  'math.GN': 'General Topology',
  'math.GR': 'Group Theory',
  'math.GT': 'Geometric Topology',
  'math.HO': 'History and Overview',
  'math.IT': 'Information Theory',
  'math.KT': 'K-Theory and Homology',
  'math.LO': 'Logic',
  'math.MG': 'Metric Geometry',
  'math.MP': 'Mathematical Physics',
  'math.NA': 'Numerical Analysis',
  'math.NT': 'Number Theory',
  'math.OA': 'Operator Algebras',
  'math.OC': 'Optimization and Control',
  'math.PR': 'Probability',
  'math.QA': 'Quantum Algebra',
  'math.RA': 'Rings and Algebras',
  'math.RT': 'Representation Theory',
  'math.SG': 'Symplectic Geometry',
  'math.SP': 'Spectral Theory',
  'math.ST': 'Statistics Theory',
});

const aliases = new Map([
  ['math-ph', 'math.MP'], ['cs.it', 'math.IT'],
  ['cs.na', 'math.NA'], ['stat.th', 'math.ST'],
]);
const archives = new Set((
  'acc-phys adap-org alg-geom ao-sci astro-ph atom-ph bayes-an chao-dyn chem-ph clus-dyn ' +
  'cmp-lg comp-gas cond-mat cs dg-ga econ eess funct-an gr-qc hep-ex hep-lat hep-ph hep-th ' +
  'math math-ph mtrl-th nlin nucl-ex nucl-th patt-sol physics plasm-ph q-alg q-bio q-fin ' +
  'quant-ph solv-int stat supr-con'
).split(' '));

export function normalizeCategory(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  if (aliases.has(code)) return aliases.get(code);
  const match = /^([a-z]+(?:-[a-z]+)?)(?:\.([a-z]+(?:-[a-z]+)*))?$/.exec(code);
  if (!match || !archives.has(match[1])) return null;
  const [, archive, subject] = match;
  if (!subject) return archive;
  const suffix = archive === 'physics' || archive === 'cond-mat' ? subject : subject.toUpperCase();
  return archive + '.' + suffix;
}
