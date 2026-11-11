/**
 * Wire protocol between the app (`SyncEngine`) and the TrailPack API
 * (`/v1/sync/*`). Shared by both sides so they can never drift apart.
 */
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, SYNCED_ENTITIES } from '@trailpack/shared';

/** Maximum number of changes per push request. */
export const MAX_PUSH_CHANGES = 500;
/** Default / maximum page size of a pull. */
export const DEFAULT_PULL_LIMIT = 500;

const changeShape = {
  entity: z.enum(SYNCED_ENTITIES),
  id: IdSchema,
  op: z.enum(['upsert', 'delete']),
  /** Full entity document; for deletes the tombstone. Required for upserts. */
  data: z.record(z.string(), z.unknown()).optional(),
  updatedAt: IsoDateTimeSchema,
  deviceId: z.string().min(1).max(64),
  /** Server-side share the entity belongs to (shared trips). */
  shareId: z.string().min(1).max(64).optional(),
};

const upsertNeedsData = (c: { op: string; data?: unknown }) => c.op === 'delete' || c.data !== undefined;
const upsertNeedsDataMessage = { message: 'upsert requires data', path: ['data'] };

export const ChangeSchema = z.object(changeShape).refine(upsertNeedsData, upsertNeedsDataMessage);
export type Change = z.infer<typeof ChangeSchema>;

export const ServerChangeSchema = z
  .object({ ...changeShape, serverSeq: z.number().int().nonnegative() })
  .refine(upsertNeedsData, upsertNeedsDataMessage);
export type ServerChange = z.infer<typeof ServerChangeSchema>;

export const PushRequestSchema = z.object({
  deviceId: z.string().min(1).max(64),
  changes: z.array(ChangeSchema).max(MAX_PUSH_CHANGES),
});
export type PushRequest = z.infer<typeof PushRequestSchema>;

export const PushResponseSchema = z.object({
  /** Number of changes the server stored. */
  accepted: z.number().int().nonnegative(),
  /** Changes the server refused permanently (they are not retried). */
  rejected: z.array(z.object({ id: z.string(), reason: z.string() })),
  /** Opaque position of the server log after this push. */
  cursor: z.string(),
});
export type PushResponse = z.infer<typeof PushResponseSchema>;

export const PullResponseSchema = z.object({
  changes: z.array(ServerChangeSchema),
  /** Pass back as `cursor` to continue after the last returned change. */
  cursor: z.string(),
  hasMore: z.boolean(),
});
export type PullResponse = z.infer<typeof PullResponseSchema>;

export const PullQuerySchema = z.object({
  cursor: z.string().regex(/^\d{1,18}$/).default('0'),
  limit: z.coerce.number().int().min(1).max(DEFAULT_PULL_LIMIT).default(DEFAULT_PULL_LIMIT),
  deviceId: z.string().min(1).max(64).optional(),
});
export type PullQuery = z.input<typeof PullQuerySchema>;

export const DeviceAuthResponseSchema = z.object({ userId: z.string(), token: z.string() });
export type DeviceAuthResponse = z.infer<typeof DeviceAuthResponseSchema>;

/** Anything that can exchange changes with a sync server. */
export interface SyncTransport {
  push(request: PushRequest, signal?: AbortSignal): Promise<PushResponse>;
  pull(query: { cursor: string; limit?: number; deviceId?: string }, signal?: AbortSignal): Promise<PullResponse>;
}
