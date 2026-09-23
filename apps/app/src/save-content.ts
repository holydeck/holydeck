// The one save path every editable content kind (songs, sermons, slide groups) is expected to call
// instead of `revisions.save()` directly, so a losing concurrent writer's body is shelved for the
// conflict UI (spec v1c-09, COLAB-02) rather than simply rejected.

import type { ConflictShelf } from './conflicts.js';
import type { RevisionStore, SaveInput, SaveOutcome } from './revisions.js';

export function saveContent(
  revisions: RevisionStore,
  conflictShelf: ConflictShelf,
): (context: unknown, input: SaveInput) => Promise<SaveOutcome> {
  return (context, input) => conflictShelf.saveWithConflictPreservation(context, revisions, input);
}
