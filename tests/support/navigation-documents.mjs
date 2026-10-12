/** Document identity for tests that stub Chrome tab creation/update. */
export function navigationDocuments() {
  const versions = new Map();
  return {
    commit(tabId) { versions.set(tabId, (versions.get(tabId) || 0) + 1); },
    result(tabId) { return [{ frameId: 0, documentId: `${tabId}:${versions.get(tabId) || 0}`, result: null }]; },
  };
}
