/**
 * Sync reducer — folds `SessionEnvelope[]` into ordered render items
 * (falcon-system-design.md §9.1, plan.md §8.2). Pure, dependency-free logic
 * over `@falcon/wire`'s `SessionEnvelope`/`SessionEvent` schemas; not wired
 * into the sync engine or timeline UI yet (later plan bullets).
 */
export { reduceEnvelopes } from "./reduce.js";
export type {
  FileItem,
  ModeSwitchItem,
  OrphanToolEndItem,
  PermissionInfo,
  PermPlaceholderItem,
  RenderItem,
  RenderItemBase,
  ServiceItem,
  SubagentGroupItem,
  SubStartItem,
  SubStopItem,
  TextItem,
  ToolItem,
  TurnEndItem,
  TurnStartItem,
  UsageItem,
} from "./types.js";
