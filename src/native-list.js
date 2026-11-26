// arXiv owns these elements. The filter writes only a temporary boolean hidden
// attribute on rows that did not already have one.
function connectedPair(pair) {
  return Boolean(pair?.dt?.isConnected && pair.dd?.isConnected &&
    pair.dt.nextElementSibling === pair.dd && pair.dt.parentElement === pair.dd.parentElement);
}

function visible(node) {
  if (node.closest('[hidden]')) return false;
  return typeof node.checkVisibility !== 'function' || node.checkVisibility({visibilityProperty:true});
}

export class NativeListing {
  constructor(paperNodes) {
    this.paperNodes = paperNodes;
    this.hiddenByFilter = new Set();
    this.applied = false;
  }

  release(node) {
    if (!this.hiddenByFilter.delete(node)) return;
    // A site-supplied replacement value, including "until-found", belongs to
    // the page. An identical empty write by another script is indistinguishable.
    if (node.getAttribute('hidden') === '') node.removeAttribute('hidden');
  }

  apply(ids) {
    if (ids == null || typeof ids === 'string' || typeof ids[Symbol.iterator] !== 'function') {
      throw new TypeError('A list of selected arXiv paper IDs is required.');
    }
    const selected = new Set(ids);
    for (const id of selected) {
      if (!connectedPair(this.paperNodes.get(id))) {
        throw new Error('A selected paper is missing from this page. Open the complete arXiv listing to apply the selection.');
      }
    }
    for (const [id, pair] of this.paperNodes) {
      if (!connectedPair(pair)) continue;
      for (const node of [pair.dt, pair.dd]) {
        if (this.hiddenByFilter.has(node) && node.getAttribute('hidden') !== '') this.hiddenByFilter.delete(node);
        if (selected.has(id)) {
          this.release(node);
        } else if (!node.hasAttribute('hidden')) {
          node.setAttribute('hidden', '');
          this.hiddenByFilter.add(node);
        }
      }
    }
    this.applied = true;
  }

  restore() {
    for (const node of this.hiddenByFilter) this.release(node);
    this.applied = false;
  }

  visibleIds() {
    const rows = [...this.paperNodes].filter(([, pair]) =>
      connectedPair(pair) && visible(pair.dt) && visible(pair.dd));
    // The page can reorder native rows after ingestion. Use their current
    // document order for keyboard navigation, independently of the draw order.
    rows.sort((a, b) => {
      const position = a[1].dt.compareDocumentPosition(b[1].dt);
      if (position & 4) return -1; // DOCUMENT_POSITION_FOLLOWING
      if (position & 2) return 1;  // DOCUMENT_POSITION_PRECEDING
      return 0;
    });
    return rows.map(([id]) => id);
  }
}
