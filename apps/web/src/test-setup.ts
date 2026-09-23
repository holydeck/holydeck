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

// Routed pages are lazy chunks. Under a parallel full-repo run a cold transform of a large chunk can outlast
// Testing Library's default 1 s `findBy` wait, so page-level waits get more room; a passing wait is unchanged.
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/preact');
  configure({ asyncUtilTimeout: 5_000 });
}
