/**
 * Defensive readers over `ToolItem.args`/`.output` (typed `unknown` on the
 * wire — falcon-system-design.md §4.2, adapter-specific shapes). Every
 * reader here degrades to `undefined` on a shape mismatch instead of
 * throwing (design principle: no silent failures at the *display* layer
 * means "never crash the card", not "never show raw JSON" — callers fall
 * back to a generic `JsonBlock` dump of the raw value when a specific field
 * is missing, so nothing is ever hidden, just possibly unformatted).
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = record?.[key];
  return typeof v === "string" ? v : undefined;
}

export function readNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const v = record?.[key];
  return typeof v === "number" ? v : undefined;
}

export function readBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const v = record?.[key];
  return typeof v === "boolean" ? v : undefined;
}

export function readRecordArray(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown>[] | undefined {
  const v = record?.[key];
  if (!Array.isArray(v)) return undefined;
  return v
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
}

export function readStringArray(
  record: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const v = record?.[key];
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((entry): entry is string => typeof entry === "string");
  return items.length > 0 ? items : undefined;
}

export interface BashArgs {
  command?: string;
  description?: string;
  timeout?: number;
}

export function parseBashArgs(args: unknown): BashArgs {
  const r = asRecord(args);
  return {
    command: readString(r, "command"),
    description: readString(r, "description"),
    timeout: readNumber(r, "timeout"),
  };
}

export interface BashOutput {
  stdout?: string;
  stderr?: string;
}

export function parseBashOutput(output: unknown): BashOutput {
  const r = asRecord(output);
  return {
    stdout: readString(r, "stdout"),
    stderr: readString(r, "stderr"),
  };
}

export interface EditEntry {
  oldString?: string;
  newString?: string;
}

export interface EditArgs {
  filePath?: string;
  oldString?: string;
  newString?: string;
  content?: string;
  edits?: EditEntry[];
}

export function parseEditArgs(args: unknown): EditArgs {
  const r = asRecord(args);
  const rawEdits = readRecordArray(r, "edits");

  return {
    filePath: readString(r, "file_path") ?? readString(r, "path"),
    oldString: readString(r, "old_string"),
    newString: readString(r, "new_string"),
    content: readString(r, "content"),
    edits: rawEdits?.map((e) => ({
      oldString: readString(e, "old_string"),
      newString: readString(e, "new_string"),
    })),
  };
}

export interface ReadArgs {
  filePath?: string;
  offset?: number;
  limit?: number;
}

export function parseReadArgs(args: unknown): ReadArgs {
  const r = asRecord(args);
  return {
    filePath: readString(r, "file_path") ?? readString(r, "path"),
    offset: readNumber(r, "offset"),
    limit: readNumber(r, "limit"),
  };
}

export interface GrepGlobArgs {
  pattern?: string;
  path?: string;
  glob?: string;
}

export function parseGrepGlobArgs(args: unknown): GrepGlobArgs {
  const r = asRecord(args);
  return {
    pattern: readString(r, "pattern"),
    path: readString(r, "path"),
    glob: readString(r, "glob"),
  };
}

export interface TodoEntry {
  content?: string;
  status?: string;
  activeForm?: string;
}

export function parseTodoItems(args: unknown): TodoEntry[] {
  const r = asRecord(args);
  const rawTodos = readRecordArray(r, "todos");
  if (!rawTodos) return [];

  return rawTodos.map((todo) => ({
    content: readString(todo, "content"),
    status: readString(todo, "status"),
    activeForm: readString(todo, "activeForm"),
  }));
}

export interface WebFetchArgs {
  url?: string;
  prompt?: string;
}

export function parseWebFetchArgs(args: unknown): WebFetchArgs {
  const r = asRecord(args);
  return {
    url: readString(r, "url"),
    prompt: readString(r, "prompt"),
  };
}

export interface WebSearchArgs {
  query?: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export function parseWebSearchArgs(args: unknown): WebSearchArgs {
  const r = asRecord(args);
  return {
    query: readString(r, "query"),
    allowedDomains: readStringArray(r, "allowed_domains"),
    blockedDomains: readStringArray(r, "blocked_domains"),
  };
}

export interface WebSearchResultItem {
  title?: string;
  url?: string;
}

/** Claude Code's `WebSearch` tool-result is a plain text blob ("Web search
 * results for query: ... \n\n ... \n\nLinks: [{"title":...,"url":...}, ...]"),
 * not structured JSON at the top level (verified against a real transcript,
 * `__fixtures__/task_non_sdk.jsonl`) — this pulls the embedded `Links: [...]`
 * array back out. Degrades to `undefined` (raw text fallback) for any other
 * shape, including a future structured-output revision. */
export function parseWebSearchResults(
  output: unknown,
): WebSearchResultItem[] | undefined {
  if (typeof output !== "string") return undefined;
  const match = output.match(/Links:\s*(\[.*?\])/s);
  if (!match?.[1]) return undefined;

  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return undefined;
    const items = parsed
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map((entry) => ({
        title: readString(entry, "title"),
        url: readString(entry, "url"),
      }))
      .filter((entry) => entry.title !== undefined || entry.url !== undefined);
    return items.length > 0 ? items : undefined;
  } catch {
    return undefined;
  }
}

export interface NotebookEditArgs {
  notebookPath?: string;
  cellId?: string;
  newSource?: string;
  cellType?: string;
  editMode?: string;
}

export function parseNotebookEditArgs(args: unknown): NotebookEditArgs {
  const r = asRecord(args);
  return {
    notebookPath: readString(r, "notebook_path"),
    cellId: readString(r, "cell_id"),
    newSource: readString(r, "new_source"),
    cellType: readString(r, "cell_type"),
    editMode: readString(r, "edit_mode"),
  };
}

export interface ExitPlanModeArgs {
  plan?: string;
}

/** `ExitPlanMode` presents a plan for approval — args shape `{ plan: string }`
 * (markdown plan text), already relied on elsewhere in this codebase's own
 * tests (`session-state.test.ts:37-45`, `:57-65`; bug-fix-plan.md #6).
 * Degrades to `undefined` on any other shape, same as every other parser
 * here. */
export function parseExitPlanModeArgs(args: unknown): ExitPlanModeArgs {
  const r = asRecord(args);
  return { plan: readString(r, "plan") };
}

export interface LsArgs {
  path?: string;
  ignore?: string[];
}

export function parseLsArgs(args: unknown): LsArgs {
  const r = asRecord(args);
  return {
    path: readString(r, "path"),
    ignore: readStringArray(r, "ignore"),
  };
}

/** True for either of Claude Code's two `AskUserQuestion` tool-name spellings
 * (mirrors `packages/cli/src/claude/pretoolPermissionBridge.ts`'s own
 * `isAskUserQuestion` — no shared runtime module between the two packages
 * for a predicate this small, plan-v2.md W2.1). */
export function isAskUserQuestion(name: string): boolean {
  return name === "AskUserQuestion" || name === "ask_user_question";
}

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestionParsed {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
}

function parseAskQuestion(raw: unknown): AskQuestionParsed | undefined {
  const qr = asRecord(raw);
  const question = readString(qr, "question");
  if (!question) return undefined;
  const rawOptions = qr?.options;
  const options = Array.isArray(rawOptions)
    ? rawOptions
        .map(parseAskOption)
        .filter((o): o is AskQuestionOption => o !== undefined)
    : [];
  return {
    question,
    header: readString(qr, "header"),
    multiSelect: readBoolean(qr, "multiSelect"),
    options,
  };
}

function parseAskOption(raw: unknown): AskQuestionOption | undefined {
  if (typeof raw === "string") return { label: raw };
  const r = asRecord(raw);
  const label = readString(r, "label");
  return label
    ? { label, description: readString(r, "description") }
    : undefined;
}

/** Reads the `AskUserQuestion` tool's `{questions: [...]}` input shape
 * (plan-v2.md W2.1) — each question's `options` may be bare strings or
 * `{label, description?}` objects; both normalize to `AskQuestionOption`.
 * Malformed questions/options are dropped rather than thrown on. */
export function parseAskQuestions(args: unknown): AskQuestionParsed[] {
  const r = asRecord(args);
  const rawQuestions = r?.questions;
  if (Array.isArray(rawQuestions)) {
    return rawQuestions
      .map(parseAskQuestion)
      .filter((q): q is AskQuestionParsed => q !== undefined);
  }

  const singleQuestion = parseAskQuestion(args);
  return singleQuestion ? [singleQuestion] : [];
}

export interface AskAnswerEntry {
  question: string;
  answer: string;
}

/** Reads a completed `AskUserQuestion` tool-end's answer, for the read-only
 * (locally-answered) ToolCard. Two tolerated shapes: `{answers: {question:
 * answer}}` (Falcon's own deny-with-answer convention, in case a future
 * transport ever mirrors it back as a real tool-end) or an array of
 * `{question, answer}` entries. Neither is a verified Claude Code tool-result
 * shape (plan-v2.md W2.1's `[human]` sub-task covers that live check) —
 * degrades to `undefined` on any other shape so the card falls back to a raw
 * dump instead of hiding data. */
export function parseAskAnswers(output: unknown): AskAnswerEntry[] | undefined {
  const r = asRecord(output);
  const answersRecord = asRecord(r?.answers);
  if (answersRecord) {
    const entries = Object.entries(answersRecord).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return entries.length > 0
      ? entries.map(([question, answer]) => ({ question, answer }))
      : undefined;
  }

  if (Array.isArray(output)) {
    const entries = output
      .map((entry) => {
        const er = asRecord(entry);
        const question = readString(er, "question");
        const answer = readString(er, "answer");
        return question && answer ? { question, answer } : undefined;
      })
      .filter((e): e is AskAnswerEntry => e !== undefined);
    return entries.length > 0 ? entries : undefined;
  }

  return undefined;
}
