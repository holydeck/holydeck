// Unmounts whatever a component test rendered, after every test. `@testing-library/preact` only does this
// on its own when the runner exposes a global `afterEach`, and this workspace's Vitest does not, so without
// this file the second test in a file would find the first test's page still in the document.
// Registered for every test file; in the node environment there is no document, so nothing is rendered
// and the cleanup is never loaded.

import { afterEach } from 'vitest';

afterEach(async () => {
  if (typeof document === 'undefined') return;
  const { cleanup } = await import('@testing-library/preact');
  cleanup();
});
