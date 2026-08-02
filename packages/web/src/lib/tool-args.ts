
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
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
export function parseWebSearchResults(output: unknown): WebSearchResultItem[] | undefined {
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

/** `ExitPlanMode` presents a plan for approval — args shape `{ plan: string }`.
 * Degrades to `undefined` on any other shape. */
export function parseExitPlanModeArgs(args: unknown): ExitPlanModeArgs {
  const r = asRecord(args);
  return { plan: readString(r, "plan") };
}

export interface TaskCreateArgs {
  subject?: string;
  description?: string;
  activeForm?: string;
}

/** `TaskCreate` — Claude Code's task-tracking tool. Verified against a real captured
 * transcript: each call creates exactly one task with `{subject, description, activeForm}`,
 * not the old `TodoWrite` `{todos: [...]}` shape. */
export function parseTaskCreateArgs(args: unknown): TaskCreateArgs {
  const r = asRecord(args);
  return {
    subject: readString(r, "subject"),
    description: readString(r, "description"),
    activeForm: readString(r, "activeForm"),
  };
}

export interface TaskUpdateArgs {
  taskId?: string;
  status?: string;
  subject?: string;
  description?: string;
  activeForm?: string;
}

/** `TaskUpdate` — a *partial patch* against one task by id, not a full
 * checklist (verified against the same real transcript as
 * `parseTaskCreateArgs`: every observed call only touched `status`, e.g.
 * `{taskId: "1", status: "in_progress"}`; real transcripts from other
 * sessions on this machine also show `subject`/`description`/`activeForm`
 * updates via the same tool — none of them ever carry the other tasks in the
 * list). `taskId` has been observed under both `taskId` (current) and
 * `task_id` (older Claude Code versions) spellings, mirroring this file's
 * existing `file_path`/`path`-style dual-spelling tolerance. Because a
 * `TaskUpdate` call never carries the full list, this card renders each call
 * as its own standalone status-change entry rather than trying to
 * reconstruct cumulative list state — no sibling-item access exists at the
 * `ToolItem` level to do that correctly (see `TaskEntryCard.tsx`). */
export function parseTaskUpdateArgs(args: unknown): TaskUpdateArgs {
  const r = asRecord(args);
  return {
    taskId: readString(r, "taskId") ?? readString(r, "task_id"),
    status: readString(r, "status"),
    subject: readString(r, "subject"),
    description: readString(r, "description"),
    activeForm: readString(r, "activeForm"),
  };
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

/** True for either of Claude Code's two `AskUserQuestion` tool-name spellings. */
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
    ? rawOptions.map(parseAskOption).filter((o): o is AskQuestionOption => o !== undefined)
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
  return label ? { label, description: readString(r, "description") } : undefined;
}

/** Reads the `AskUserQuestion` tool's `{questions: [...]}` input shape.
 * Each question's `options` may be bare strings or `{label, description?}` objects;
 * both normalize to `AskQuestionOption`. Malformed entries are dropped. */
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

/**
 * Matches one `"question"="answer"` pair, as Claude Code's own real
 * `AskUserQuestion` tool_result string embeds them (see `parseAskAnswers`'s
 * own doc comment for the verified full-string shape). Doesn't handle an
 * embedded literal `"` inside a question/answer (Claude Code's own string
 * doesn't escape one either, as far as verified) — an unmatched quote there
 * just fails to match, degrading to the raw-dump fallback like any other
 * unrecognized shape, never a crash.
 */
const ASK_ANSWER_PAIR_PATTERN = /"([^"]*)"="([^"]*)"/g;

/**
 * Matches Kvy's own "deny-with-answer" tool_result text — `composeAskAnswerReason()`
 * in `packages/cli/src/claude/pretoolPermissionBridge.ts`, e.g.:
 * ```
 * The user answered via the Kvy web UI:
 * - Pick a fruit
 *   → Mango
 * Proceed using these answers. Do not call AskUserQuestion again for these questions.
 * ```
 * Used whenever a web `perm.answer` decision for `AskUserQuestion` can't be driven into
 * a live terminal widget — always true for a question raised on a web-initiated turn
 * (there is no local dialog to drive at all), and also true for a free-text answer on a
 * locally-typed turn (the widget's keystroke model can only select a listed option).
 * Claude Code has no channel to hand a modified tool result back to a still-pending
 * `AskUserQuestion` call, so the answer is baked into the deny reason — which is why
 * this shows up as `is_error: true` even though it's a successful answer. This regex
 * recovers the real answer so the card can display it; `AskUserQuestionToolCard.tsx`
 * separately prevents the status badge from reading "Error" for this case.
 */
const ASK_ANSWER_ARROW_PATTERN = /^- (.+)\n {2}→ (.+)$/gm;

/** Reads a completed `AskUserQuestion` tool-end's answer, for the read-only
 * (locally-answered) ToolCard. Three tolerated shapes, tried in order:
 *
 * 1. A plain string matching Claude Code's own real tool_result `content`
 *    (verified against real transcripts, Claude Code 2.1.218). A
 *    picked-option answer, single-question:
 *    ```
 *    Your questions have been answered: "Which color do you prefer?"="Blue".
 *    You can now continue with these answers in mind.
 *    ```
 *    or multi-question in one call:
 *    ```
 *    Your questions have been answered: "Which color do you prefer?"="Red",
 *    "Which size?"="Small". You can now continue with these answers in mind.
 *    ```
 *    A free-text "Type something" answer uses a genuinely DIFFERENT wrapper
 *    sentence (verified live, not assumed) — "The user answered: ..." rather
 *    than "Your questions have been answered: ...":
 *    ```
 *    The user answered: "What is your favorite drink?"="Hot chocolate". Read
 *    the answers carefully — they may request clarification, changes, or
 *    that you not proceed — and follow what they actually say.
 *    ```
 *    Neither the prefix nor suffix sentence is pinned down (a future Claude
 *    Code build could reword either, and there may be other variants this
 *    hasn't seen) — this scans the whole string for `"question"="answer"`
 *    pairs wherever they appear, which is why both wrappers above parse
 *    identically without special-casing which one it is, and also means an
 *    answer that itself contains a comma (e.g. "Yes, please") parses
 *    correctly, since pairs are found by quote-matching, not by splitting on
 *    `, `. A declined/"Chat about this" tool_result is a third, structurally
 *    different string ("The user doesn't want to proceed with this tool
 *    use...", `is_error: true`) with no `"..."="..."` pair in it at all, so
 *    it naturally falls through to `undefined` here — `isDeclinedQuestion`
 *    in `AskUserQuestionToolCard.tsx` is what actually recognizes that case,
 *    entirely independently of this function.
 * 2. Kvy's own "deny-with-answer" reason text ({@link ASK_ANSWER_ARROW_PATTERN}) —
 *    the shape used for a web-answered question that couldn't be driven into a live
 *    terminal widget. Carries `is_error: true` on the wire even though it is a
 *    successful answer.
 * 3. `{answers: {question: answer}}` (Kvy's own deny-with-answer convention as a
 *    structured value, in case a future transport ever mirrors it back that way instead
 *    of as a string).
 * 4. An array of `{question, answer}` entries.
 *
 * Degrades to `undefined` on any other shape (including a declined/rejected
 * tool_result string, which never contains a `"..."="..."` pair or a `- .../  → ...`
 * line) so the card falls back to a raw dump instead of hiding data.
 */
export function parseAskAnswers(output: unknown): AskAnswerEntry[] | undefined {
  if (typeof output === "string") {
    const quoted = Array.from(output.matchAll(ASK_ANSWER_PAIR_PATTERN))
      .map((match) => ({ question: match[1] ?? "", answer: match[2] ?? "" }))
      .filter((entry): entry is AskAnswerEntry => entry.question.length > 0);
    if (quoted.length > 0) return quoted;

    const arrowed = Array.from(output.matchAll(ASK_ANSWER_ARROW_PATTERN))
      .map((match) => ({ question: match[1] ?? "", answer: match[2] ?? "" }))
      .filter((entry): entry is AskAnswerEntry => entry.question.length > 0);
    return arrowed.length > 0 ? arrowed : undefined;
  }

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
