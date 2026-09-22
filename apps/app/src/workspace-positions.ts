import type { WorkspacePosition } from '@holydeck/contracts/workspace';
import type { Db } from 'mongodb';

import type { Document, Filter } from './repositories.js';

export const WORKSPACE_POSITION_COLLECTION = 'workspacePositions';

/** The slice of a Mongo collection this store uses. */
export interface WorkspacePositionCollection {
  findOne(filter: Filter): Promise<Document | null>;
  replaceOne(filter: Filter, replacement: Document, options: { readonly upsert: true }): Promise<unknown>;
}

export interface WorkspacePositionDb {
  collection(name: string): WorkspacePositionCollection;
}

export interface WorkspacePositionStore {
  read(actor: string): Promise<(WorkspacePosition & { readonly updatedAt: string }) | undefined>;
  write(actor: string, position: WorkspacePosition): Promise<WorkspacePosition & { readonly updatedAt: string }>;
}

export interface WorkspacePositionOptions {
  readonly now: () => string;
}

/** The store over one database. Nothing here reads an ambient clock, database or current user. */
export function workspacePositionsOn(
  db: WorkspacePositionDb,
  options: WorkspacePositionOptions,
): WorkspacePositionStore {
  const rows = (): WorkspacePositionCollection => db.collection(WORKSPACE_POSITION_COLLECTION);

  return Object.freeze({
    async read(actor: string) {
      const document = await rows().findOne({ _id: actor });
      if (document === null) return undefined;
      const position = { ...document };
      delete position['_id'];
      return position as WorkspacePosition & { readonly updatedAt: string };
    },

    async write(actor: string, position: WorkspacePosition) {
      const updatedAt = options.now();
      await rows().replaceOne({ _id: actor }, { _id: actor, ...position, updatedAt }, { upsert: true });
      return { ...position, updatedAt };
    },
  });
}

/** The driver satisfies this interface in practice; the cast is about the document types the driver reports. */
export function workspacePositionDb(db: Db): WorkspacePositionDb {
  return { collection: (name) => db.collection(name) as unknown as WorkspacePositionCollection };
}
