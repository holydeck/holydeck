// The workspace position contract exists so SERV-01 can persist each user's last-viewed position
// without allowing an item or slide to outlive the service context that holds it (D03-1).

import { FIELD_CODES, type Parsed, parseObject } from './problems.js';

/** Where one account last was in the workspace. Every field is optional: a fresh account has none. */
export type WorkspacePosition = {
  readonly serviceId?: string;
  readonly contentId?: string;
  readonly itemId?: string;
  readonly slideId?: string;
};

const FIELDS = ['serviceId', 'contentId', 'itemId', 'slideId'] as const;

/** The PUT body for `/api/v1/me/workspace-position`, and the shape the GET answers. */
export function parseWorkspacePosition(value: unknown): Parsed<WorkspacePosition> {
  return parseObject(value, 'position', (reader) => {
    const position: Record<string, string> = {};
    for (const field of FIELDS) {
      const found = reader.optionalText(field);
      if (found === undefined) continue;
      if (found === '') reader.reject(field, FIELD_CODES.empty, 'must not be empty');
      position[field] = found;
    }
    if (position['serviceId'] === undefined) {
      for (const field of ['itemId', 'slideId'] as const) {
        if (position[field] !== undefined) reader.reject(field, FIELD_CODES.notAllowed, 'needs a serviceId');
      }
    } else if (position['slideId'] !== undefined && position['itemId'] === undefined && position['contentId'] === undefined) {
      reader.reject('slideId', FIELD_CODES.notAllowed, 'needs an itemId or a contentId');
    }
    return position as WorkspacePosition;
  });
}
