import {CATEGORIES} from './categories.js';

export const FEEDS = Object.freeze([
  ['today','Today'], ['trending','Trending'], ['rising','Rising'], ['for-you','For You'],
  ['discovery','Discovery'], ['subscriptions','Subscriptions'], ['highlights','Highlights'],
  ['random','Random'], ['recent','Recent'], ['saved','Saved']
]);

export const DEFAULT_FEED_SETTINGS = Object.freeze({
  landing: 'today', categories: [], includeCross: true, includeReplacements: true,
  maxDisplayed: 0, refreshMinutes: 60, minimumCoverage: 0.75, maxMetricAgeHours: 48,
  provider: 'none', metric: '', showRaw: true, showGrowth: true,
  randomBalanced: true, randomCount: 50, discoveryIntensity: 1,
  author: '', date: '', reading: 'all', bookmark: 'all', section: 'all', search: '',
  savedSort: 'saved', highlightBatch: 1
});

// Additive settings keep old backups and the established interest model intact.
export function checkedFeedSettings(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid feed settings.');
  const s = {...DEFAULT_FEED_SETTINGS, ...raw};
  const result = {};
  const choice = (key, values) => {
    if (!values.includes(s[key])) throw new Error('Invalid feed setting: ' + key + '.');
    result[key] = s[key];
  };
  const number = (key, low, high, integer = false) => {
    if (!Number.isFinite(s[key]) || s[key] < low || s[key] > high || (integer && !Number.isInteger(s[key]))) throw new Error('Invalid feed setting: ' + key + '.');
    result[key] = s[key];
  };
  choice('landing', FEEDS.map(([id]) => id));
  for (const key of ['includeCross','includeReplacements','showRaw','showGrowth','randomBalanced']) {
    if (typeof s[key] !== 'boolean') throw new Error('Invalid feed setting: ' + key + '.');
    result[key] = s[key];
  }
  if (!Array.isArray(s.categories) || s.categories.length > 32 || s.categories.some(c => !Object.hasOwn(CATEGORIES,c))) throw new Error('Invalid feed categories.');
  result.categories = [...new Set(s.categories)].sort();
  number('maxDisplayed',0,10000,true); number('refreshMinutes',15,10080,true);
  number('minimumCoverage',0.25,1); number('maxMetricAgeHours',1,168);
  number('randomCount',1,200,true); number('discoveryIntensity',0,1); number('highlightBatch',1,10,true);
  for (const key of ['provider','metric','author','date','search']) {
    if (typeof s[key] !== 'string' || s[key].length > (['author','search'].includes(key) ? 500 : 100)) throw new Error('Invalid feed setting: ' + key + '.');
    result[key] = s[key].trim();
  }
  if (!/^[a-z0-9_-]+$/.test(result.provider) || !/^[a-z0-9_.:-]*$/i.test(result.metric)) throw new Error('Invalid provider or metric.');
  if (result.date && (!/^\d{4}-\d{2}-\d{2}$/.test(result.date) || new Date(result.date + 'T00:00:00Z').toISOString().slice(0,10) !== result.date)) throw new Error('Invalid announcement date.');
  choice('reading',['all','read','unread']); choice('bookmark',['all','saved','unsaved']);
  choice('section',['all','new','cross','replacement','unknown']); choice('savedSort',['saved','date','title']);
  return result;
}
