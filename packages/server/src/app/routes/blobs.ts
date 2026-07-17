/**
 * Blob storage subsystem (falcon-system-design.md §6.2 "POST /blobs/
 * request-upload   POST /blobs/request-download", §6.5; plan.md §16 "4.3
 * Distribution & self-host": "Blob storage: presigned upload/download
 * routes + S3/local-disk drivers"). The server is blind to blob content —
 * callers encrypt with `encryptBlob`/a DEK-derived blob key
 * (`deriveBlobKey`, design §5.1) before ever calling `request-upload`; this
 * module only brokers presigned URLs and records accounting metadata
 * (`blobs` table: owner, size, contentHash).
 *
 * This is also the fallback path `git.diff`/`adopt.mirror`/file-attachment
 * envelopes reserve `blobRef` for once a payload would blow the 64KB RPC
 * control-plane budget (design §4.4 "payload size rule") — a `blobId`
 * minted here is exactly what those `blobRef` fields carry.
 *
 * Three routes:
 *  - `POST /v1/blobs/request-upload` — mint a `blobs` row + an upload
 *    target from the active driver (S3 presigned PUT, or the local-disk
 *    driver's own signed sink URL below).
 *  - `POST /v1/blobs/request-download` — look up an owned `blobs` row, mint
 *    a download target the same way.
 *  - `PUT`/`GET /v1/blobs/local/:id` — the local-disk driver's own sink,
 *    only mounted when that driver is active (an S3-backed deployment has
 *    no use for it, and mounting write endpoints nobody's presigned URLs
 *    ever point at is just needless attack surface). Authorized by the
 *    short-lived HMAC token embedded in the URL's query string
 *    (`localToken.ts`), not `app.authenticate` — the whole point of a
 *    presigned URL is that the bearer of the URL is the authorization, same
 *    as a real S3 presigned URL needs no separate bearer token.
 */
import { createHash } from "node:crypto";
import {
  BlobRequestDownloadBodySchema,
  BlobRequestDownloadResultSchema,
  BlobRequestUploadBodySchema,
  BlobRequestUploadResultSchema,
} from "@falcon/wire";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BlobStorageDriver } from "../../blobStorage/index.js";
import type { LocalDriverConfig } from "../../blobStorage/localDriver.js";
import { readLocalBlob, writeLocalBlob } from "../../blobStorage/localDriver.js";
import { verifyBlobToken } from "../../blobStorage/localToken.js";
import { blobs, sessions } from "../../db/schema.js";
import type { Database } from "../../db/types.js";
import { NotFoundSchema } from "./shared.js";

const ErrorSchema = z.object({ error: z.string() });

export interface BlobsRouteOptions {
  maxSizeBytes: number;
  /** Public origin THIS server is reachable at, for building the local driver's self-referential sink URLs; unset reflects the incoming request's own scheme/host (see `config.ts`'s `PUBLIC_API_ORIGIN` doc comment). */
  publicApiOrigin?: string;
  /** Required (and only consulted) when `blobStorage.kind === "local"` — the same dir/token-secret the injected local driver itself was built with (`blobStorage/index.ts`'s `resolveLocalDriverConfig`), passed explicitly rather than re-read from a global so tests can point the sink at a throwaway temp dir without touching process env. */
  local?: LocalDriverConfig;
}

/** Reflects the incoming request's own scheme/host unless `publicApiOrigin` overrides it. */
function resolveBaseUrl(request: FastifyRequest, publicApiOrigin?: string): string {
  if (publicApiOrigin) return publicApiOrigin.replace(/\/$/, "");
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto =
    typeof forwardedProto === "string" ? forwardedProto.split(",")[0] : request.protocol;
  return `${proto}://${request.hostname}`;
}

export function buildBlobsRoutes(
  db: Database,
  blobStorage: BlobStorageDriver,
  opts: BlobsRouteOptions,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/blobs/request-upload",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          body: BlobRequestUploadBodySchema,
          response: { 200: BlobRequestUploadResultSchema, 400: ErrorSchema, 404: NotFoundSchema },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { size, contentHash, sessionId } = req.body;

        if (size > opts.maxSizeBytes) {
          return reply.code(400).send({
            error: `blob size ${size} exceeds the ${opts.maxSizeBytes}-byte limit`,
          });
        }

        // A caller-supplied `sessionId` must actually belong to this account —
        // otherwise one account could tag its blob-accounting rows onto
        // another account's session id (no data exposure since blob bytes
        // are opaque ciphertext either way, but still a bogus foreign key
        // this server has no business accepting).
        if (sessionId) {
          const owned = await db.query.sessions.findFirst({
            where: and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)),
          });
          if (!owned) return reply.code(404).send({});
        }

        const [row] = await db
          .insert(blobs)
          .values({ accountId, sessionId: sessionId ?? null, size, contentHash })
          .returning();
        if (!row) throw new Error("POST /v1/blobs/request-upload: insert returned no row");

        const target = await blobStorage.createUploadTarget({
          key: row.id,
          size,
          baseUrl: resolveBaseUrl(req, opts.publicApiOrigin),
        });

        return {
          blobId: row.id,
          uploadUrl: target.url,
          method: target.method,
          headers: target.headers,
        };
      },
    );

    app.post(
      "/v1/blobs/request-download",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
        schema: {
          body: BlobRequestDownloadBodySchema,
          response: { 200: BlobRequestDownloadResultSchema, 404: NotFoundSchema },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { blobId } = req.body;

        const row = await db.query.blobs.findFirst({
          where: and(eq(blobs.id, blobId), eq(blobs.accountId, accountId)),
        });
        if (!row) return reply.code(404).send({});

        const target = await blobStorage.createDownloadTarget({
          key: row.id,
          baseUrl: resolveBaseUrl(req, opts.publicApiOrigin),
        });

        return { downloadUrl: target.url, method: target.method, headers: target.headers };
      },
    );

    // The local-disk driver's own upload/download sink — only meaningful
    // (and only mounted) when that driver is the active one; see this
    // file's header comment for why an S3-backed deployment skips it
    // entirely rather than mounting dead routes.
    if (blobStorage.kind === "local") {
      if (!opts.local) {
        throw new Error(
          "buildBlobsRoutes: opts.local is required when blobStorage.kind === 'local'",
        );
      }
      const localConfig = opts.local;

      // Scoped to this nested plugin registration only (Fastify's
      // encapsulation) — the raw-buffer content-type parser must not leak
      // out and shadow the JSON parser every other route in this process
      // depends on.
      await app.register(async (local) => {
        local.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
          done(null, body);
        });

        local.put(
          "/v1/blobs/local/:id",
          {
            bodyLimit: opts.maxSizeBytes,
            config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
          },
          async (req, reply) => {
            const { id } = req.params as { id: string };
            const query = req.query as { op?: string; token?: string; exp?: string };
            const exp = Number(query.exp);
            const valid =
              query.op === "upload" &&
              typeof query.token === "string" &&
              verifyBlobToken(localConfig.tokenSecret, "upload", id, exp, query.token);
            if (!valid) return reply.code(401).send({ error: "invalid or expired upload token" });

            const body = req.body;
            if (!Buffer.isBuffer(body)) {
              return reply.code(400).send({ error: "expected a raw binary body" });
            }

            // The row must exist (minted by `request-upload` above) and
            // still match the size that was declared then — a mismatch
            // means either a stale/reused token or a body the caller never
            // ran through `request-upload` for, neither of which this sink
            // should silently accept.
            const row = await db.query.blobs.findFirst({ where: eq(blobs.id, id) });
            if (!row) return reply.code(404).send({});
            if (body.length !== row.size) {
              return reply.code(400).send({
                error: `uploaded ${body.length} bytes, expected ${row.size} (declared at request-upload time)`,
              });
            }

            await writeLocalBlob(localConfig.dir, id, body);
            return reply.code(200).send({ ok: true });
          },
        );

        local.get(
          "/v1/blobs/local/:id",
          { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
          async (req, reply) => {
            const { id } = req.params as { id: string };
            const query = req.query as { op?: string; token?: string; exp?: string };
            const exp = Number(query.exp);
            const valid =
              query.op === "download" &&
              typeof query.token === "string" &&
              verifyBlobToken(localConfig.tokenSecret, "download", id, exp, query.token);
            if (!valid) return reply.code(401).send({ error: "invalid or expired download token" });

            const bytes = await readLocalBlob(localConfig.dir, id);
            if (!bytes) return reply.code(404).send({});

            return reply.header("content-type", "application/octet-stream").send(bytes);
          },
        );
      });
    }
  };
}

/** SHA-256 hex digest — the same hash shape `contentHash` request bodies carry; exported so tests (and, if ever needed, callers) can compute it consistently. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
