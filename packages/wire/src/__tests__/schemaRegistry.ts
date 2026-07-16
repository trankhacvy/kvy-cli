import type { z } from "zod";
import * as wire from "../index";

/**
 * Every wire schema covered by the additive-only compat check. Add new
 * top-level schemas here as they're introduced — the fixture in
 * `__fixtures__/wire-shapes.json` is regenerated (never hand-edited) by
 * `scripts/snapshot-shapes.ts` once a schema's shape is ready to freeze.
 */
export const schemaRegistry: Record<string, z.ZodTypeAny> = {
  EncryptedBoxSchema: wire.EncryptedBoxSchema,
  PermissionModeSchema: wire.PermissionModeSchema,
  PermDecisionSchema: wire.PermDecisionSchema,
  SessionEventSchema: wire.SessionEventSchema,
  SessionEnvelopeSchema: wire.SessionEnvelopeSchema,
  SessionRowSchema: wire.SessionRowSchema,
  MachineRowSchema: wire.MachineRowSchema,
  UnmanagedSessionRowSchema: wire.UnmanagedSessionRowSchema,
  UpdateSchema: wire.UpdateSchema,
  EphemeralSchema: wire.EphemeralSchema,
  RpcCallSchema: wire.RpcCallSchema,
  SpawnParamsSchema: wire.SpawnParamsSchema,
  SpawnResultSchema: wire.SpawnResultSchema,
  StopSessionParamsSchema: wire.StopSessionParamsSchema,
  StopSessionResultSchema: wire.StopSessionResultSchema,
  ResumeSessionParamsSchema: wire.ResumeSessionParamsSchema,
  ResumeSessionResultSchema: wire.ResumeSessionResultSchema,
  ListSessionsResultSchema: wire.ListSessionsResultSchema,
  GitStatusParamsSchema: wire.GitStatusParamsSchema,
  GitStatusResultSchema: wire.GitStatusResultSchema,
  GitDiffParamsSchema: wire.GitDiffParamsSchema,
  GitDiffResultSchema: wire.GitDiffResultSchema,
  FsReadParamsSchema: wire.FsReadParamsSchema,
  FsReadResultSchema: wire.FsReadResultSchema,
  FsListParamsSchema: wire.FsListParamsSchema,
  FsListResultSchema: wire.FsListResultSchema,
  FsMkdirParamsSchema: wire.FsMkdirParamsSchema,
  FsMkdirResultSchema: wire.FsMkdirResultSchema,
  AdoptListParamsSchema: wire.AdoptListParamsSchema,
  AdoptListResultSchema: wire.AdoptListResultSchema,
  AdoptTakeParamsSchema: wire.AdoptTakeParamsSchema,
  AdoptTakeResultSchema: wire.AdoptTakeResultSchema,
  AdoptMirrorParamsSchema: wire.AdoptMirrorParamsSchema,
  AdoptMirrorResultSchema: wire.AdoptMirrorResultSchema,
  MessageRpcParamsSchema: wire.MessageRpcParamsSchema,
  MessageRpcResultSchema: wire.MessageRpcResultSchema,
  PermAnswerParamsSchema: wire.PermAnswerParamsSchema,
  PermAnswerResultSchema: wire.PermAnswerResultSchema,
  InterruptResultSchema: wire.InterruptResultSchema,
  TakeControlResultSchema: wire.TakeControlResultSchema,
  SetModeParamsSchema: wire.SetModeParamsSchema,
  SetModeResultSchema: wire.SetModeResultSchema,
  LifecycleKindSchema: wire.LifecycleKindSchema,
  PushChannelSchema: wire.PushChannelSchema,
  PushSubscribeBodySchema: wire.PushSubscribeBodySchema,
  PushUnsubscribeBodySchema: wire.PushUnsubscribeBodySchema,
  PushPayloadSchema: wire.PushPayloadSchema,
};
