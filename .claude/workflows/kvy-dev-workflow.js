export const meta = {
  name: 'kvy-dev-loop',
  description: 'plan-v2.md executor: unit-finder → sized pipelines (inline batch | bundle | solo) → real worktree merge with ancestry proof; dedupes across cycles, backs off on rate limits',
  phases: [
    { title: 'Task Discovery', detail: 'Find 1-2 unclaimed execution units from plan-v2.md Master TODO' },
    { title: 'Worktree Setup', detail: 'Agent creates real git worktrees (verified, not logged)' },
    { title: 'Implementation', detail: 'inline: one combined agent; bundle/solo: full pipeline' },
    { title: 'Testing', detail: 'Tests written+run in the worktree' },
    { title: 'Review & Fix', detail: 'Fix found issues, then code review' },
    { title: 'Verification', detail: 'Independent test/typecheck pass per worktree' },
    { title: 'Merge', detail: 'Real merge into v2-pty-injection + git merge-base --is-ancestor proof' },
    { title: 'Cleanup & Progress', detail: 'Remove worktrees, tick plan-v2.md, update progress.md' },
  ],
};

// ============ Config ============
const TARGET_BRANCH = 'v2-pty-injection'; // NOT main — main stays at the pre-PTY ACP state (plan-v2.md Phase 5)
const WORKTREE_ROOT = '.worktrees';
const MAX_CYCLES = 20;
const MAX_UNITS_PER_CYCLE = 2;   // small fan-out on purpose: rate-limit pressure + review quality
const BUDGET_FLOOR = 80_000;     // stop starting new cycles below this many remaining tokens

// ============ Cross-cycle memory (fixes the duplicate-task problem) ============
// attempted: selected at least once this run — finder must not re-propose these.
// failedOnce: failed exactly once — released back for ONE retry in a later cycle.
// parked: failed twice or merge-conflicted — needs a human, never auto-retried.
const attempted = new Set();
const failedOnce = new Set();
const parked = new Set();
let coolOff = false; // true after a cycle with agent nulls (rate limit / crash) → next cycle picks 1 unit
let consecutiveDiscoveryFailures = 0; // 3 in a row ⇒ sustained outage ⇒ stop cleanly

// agent() returns null when the sub-agent dies on a terminal API error (rate
// limit, crash). One in-place retry absorbs transient failures; a second null
// is a real signal the caller must handle.
async function retryAgent(prompt, opts, attempts = 2) {
  for (let i = 1; i <= attempts; i++) {
    const label = i > 1 ? `${opts.label}-retry${i - 1}` : opts.label;
    // Every workflow agent runs on Sonnet 5 — the orchestrating session model
    // (Fable) is for the main loop only; per-call opts.model may still override.
    const result = await agent(prompt, { ...opts, model: opts.model ?? 'sonnet', label });
    if (result) return result;
    log(`⚠️ [${opts.label}] agent returned null (attempt ${i}/${attempts}) — rate limit or crash`);
    coolOff = true;
  }
  return null;
}

function recordFailure(unitId, reason) {
  if (failedOnce.has(unitId)) {
    parked.add(unitId);
    log(`🅿️ [${unitId}] failed twice — PARKED for human attention (${reason})`);
  } else {
    failedOnce.add(unitId);
    attempted.delete(unitId); // release for exactly one retry in a later cycle
    log(`🔁 [${unitId}] failed once — released for one retry (${reason})`);
  }
}

// ============ Main loop ============
let cycleCount = 0;

while (cycleCount < MAX_CYCLES) {
  if (budget.total && budget.remaining() < BUDGET_FLOOR) {
    log(`🛑 Budget floor reached (${Math.round(budget.remaining() / 1000)}k left) — stopping cleanly.`);
    break;
  }
  cycleCount++;
  log(`\n=== CYCLE ${cycleCount} ${coolOff ? '(cool-off: 1 unit max)' : ''} ===`);
  const unitCap = coolOff ? 1 : MAX_UNITS_PER_CYCLE;
  coolOff = false;

  // ---- PHASE 1: Task Discovery ----
  phase('Task Discovery');

  const discovery = await retryAgent(
    `You are the unit-finder for the Kvy project, branch ${TARGET_BRANCH}.

1. Read plan-v2.md — ONLY the "Master TODO checklist (execution units)" section is
   your task source (the wave sections above it are the design detail each unit
   references). Read progress.md too if it exists.
2. Units are the "U*.*" checkbox items, each tagged [inline], [bundle], [solo],
   [human], or [parked].
3. Select the next 1-${unitCap} units that are ALL of:
   - unchecked ([ ]) in plan-v2.md
   - NOT tagged [human] or [parked] (those need the human / are deferred)
   - NOT in this exclusion list (already claimed this run): ${JSON.stringify([...attempted])}
   - NOT in this parked list: ${JSON.stringify([...parked])}
   - dependency-clean: every unit the doc says gates them is already checked [x]
     (e.g. U2.1 is gated on U0.3+U1.2). A [human] gate that is unchecked BLOCKS
     its dependents — skip them and say so in reasoning.
   - if selecting 2, they must touch disjoint files/packages (the unit doc lists
     files) so their worktrees can't conflict.
4. Prefer earlier phases; prefer unblocking units over polish.
5. status semantics — read carefully: "completed" means ZERO workflow-eligible
   units remain in the ENTIRE plan; it must NEVER be returned alongside a
   non-empty units list. If you are selecting units, status is "in-progress".
6. For each selected unit copy its FULL sub-task list verbatim from plan-v2.md into
   tasks[] — the implementer must not need to re-derive scope.`,
    {
      label: 'find-units',
      phase: 'Task Discovery',
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['in-progress', 'completed', 'blocked'] },
          units: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                unit_id: { type: 'string' },
                kind: { type: 'string', enum: ['inline', 'bundle', 'solo'] },
                title: { type: 'string' },
                tasks: { type: 'array', items: { type: 'string' } },
                files_hint: { type: 'array', items: { type: 'string' } },
                design_refs: { type: 'array', items: { type: 'string' } },
              },
              required: ['unit_id', 'kind', 'title', 'tasks'],
            },
          },
          reasoning: { type: 'string' },
        },
        required: ['status', 'units', 'reasoning'],
      },
    },
  );

  if (!discovery) {
    consecutiveDiscoveryFailures++;
    log(`⚠️ Unit finder unavailable (${consecutiveDiscoveryFailures} in a row) — rate limited?`);
    if (consecutiveDiscoveryFailures >= 3) {
      // A sustained API outage (e.g. session limit) — burning remaining cycles
      // on null discoveries helps nobody. Exit cleanly; resume when it resets.
      log('🛑 3 consecutive discovery failures — stopping cleanly. Resume this run after the limit resets.');
      break;
    }
    continue;
  }
  consecutiveDiscoveryFailures = 0;
  if (discovery.status === 'completed' && discovery.units.length === 0) {
    log('✅ All workflow-eligible units complete!');
    break;
  }
  if (discovery.status === 'completed') {
    // Defensive: a finder once said "completed" while returning units (cycle 4,
    // run wf_42de52be-701) — units win over the status flag.
    log('⚠️ Finder said "completed" but returned units — treating as in-progress.');
  }
  if (discovery.status === 'blocked' || discovery.units.length === 0) {
    log(`⏸️ No eligible units: ${discovery.reasoning}`);
    log(`   Parked (needs human): ${[...parked].join(', ') || 'none'}`);
    break; // blocked on [human] gates — looping further would spin uselessly
  }

  // Defense-in-depth dedupe: never run a unit twice even if the finder ignores
  // the exclusion list, and never run duplicates within one cycle.
  const seenThisCycle = new Set();
  const units = discovery.units.filter((u) => {
    if (attempted.has(u.unit_id) || parked.has(u.unit_id) || seenThisCycle.has(u.unit_id)) {
      log(`🚫 [${u.unit_id}] duplicate selection filtered out`);
      return false;
    }
    seenThisCycle.add(u.unit_id);
    return true;
  }).slice(0, unitCap);
  if (units.length === 0) { continue; }
  for (const u of units) attempted.add(u.unit_id);
  log(`Selected: ${units.map((u) => `${u.unit_id}(${u.kind})`).join(', ')}`);

  // ---- PHASE 2: Worktree Setup (REAL — one agent creates and verifies all) ----
  phase('Worktree Setup');

  const setup = await retryAgent(
    `You set up git worktrees for the Kvy repo (repo root = cwd).

For EACH of these units, run exactly:
  git worktree add -B wf/<unit_id> ${WORKTREE_ROOT}/<unit_id> ${TARGET_BRANCH}

Units: ${JSON.stringify(units.map((u) => u.unit_id))}

Then VERIFY with \`git worktree list\` that every path exists and is on its
wf/<unit_id> branch.
IMPORTANT: if the worktree/branch ALREADY EXISTS (a prior attempt), KEEP IT
EXACTLY AS IS — do not recreate, reset, or rebase it; just verify it exists and
report ok with reused=true. Prior commits there are valuable partial work the
pipeline will resume. Only create fresh when absent. Report per unit.`,
    {
      label: 'setup-worktrees',
      phase: 'Worktree Setup',
      effort: 'low',
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                unit_id: { type: 'string' },
                ok: { type: 'boolean' },
                worktree_path: { type: 'string' },
                branch: { type: 'string' },
                reused: { type: 'boolean' },
                error: { type: 'string' },
              },
              required: ['unit_id', 'ok', 'worktree_path', 'branch'],
            },
          },
        },
        required: ['results'],
      },
    },
  );

  const readyUnits = [];
  for (const u of units) {
    const r = setup?.results?.find((x) => x.unit_id === u.unit_id);
    if (r?.ok) readyUnits.push({ ...u, wtPath: r.worktree_path, branch: r.branch });
    else recordFailure(u.unit_id, `worktree setup failed: ${r?.error ?? 'setup agent unavailable'}`);
  }
  if (readyUnits.length === 0) { continue; }

  // ---- PHASES 3-5: sized pipelines, parallel across units ----
  log(`Running ${readyUnits.length} pipeline(s)...`);
  const pipelineResults = await parallel(
    readyUnits.map((u) => () => (u.kind === 'inline' ? runInlineUnit(u) : runFullPipeline(u))),
  );

  // ---- PHASE 6: Verification (independent pass, all kinds) ----
  phase('Verification');
  const verifiedUnits = [];
  for (let i = 0; i < readyUnits.length; i++) {
    const u = readyUnits[i];
    if (!pipelineResults[i]) { recordFailure(u.unit_id, 'pipeline failed'); continue; }

    const verify = await retryAgent(
      `Independently verify Kvy unit ${u.unit_id} ("${u.title}") in worktree ${u.wtPath}
before it merges to ${TARGET_BRANCH}.

1. cd ${u.wtPath}
2. pnpm build && pnpm typecheck && pnpm test (full, not scoped) && pnpm lint
   (lint auto-retries once; failing twice is real — see CLAUDE.md)
3. git log ${TARGET_BRANCH}..HEAD --oneline — confirm commits exist and messages
   reference the unit
4. Read task-summary/${u.unit_id}.md and spot-check the listed files against the
   unit's sub-task list: ${JSON.stringify(u.tasks)}
5. Confirm no sub-task was silently skipped (a skipped [human]-live check is fine
   and expected — those are for the human).
Report honestly; do NOT fix anything.`,
      {
        label: `verify-${u.unit_id}`,
        phase: 'Verification',
        schema: {
          type: 'object',
          properties: {
            verified: { type: 'boolean' },
            issues: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
          },
          required: ['verified', 'issues', 'summary'],
        },
      },
    );

    if (verify?.verified) verifiedUnits.push(u);
    else recordFailure(u.unit_id, `verification failed: ${(verify?.issues ?? ['verifier unavailable']).join('; ')}`);
  }

  // ---- PHASE 7: Merge (REAL, sequential, ancestry-proven — the false-landing fix) ----
  phase('Merge');
  const mergedUnits = [];
  for (const u of verifiedUnits) {
    const merge = await retryAgent(
      `Merge verified Kvy unit ${u.unit_id} into the real ${TARGET_BRANCH} ref.
Work from the MAIN repo root (cwd), NOT the worktree.

1. git checkout ${TARGET_BRANCH}  (confirm with git branch --show-current)
2. TIP=$(git rev-parse wf/${u.unit_id})
3. git merge --no-ff wf/${u.unit_id} -m "merge: ${u.unit_id} — ${u.title}"
   - On CONFLICT: git merge --abort, report merged=false with the conflicting
     files. Do NOT resolve conflicts yourself.
4. PROVE the landing (plan.md §17 false-landing lesson — a merge you cannot
   prove did not happen):
   - git merge-base --is-ancestor $TIP ${TARGET_BRANCH} && echo ANCESTRY-OK
   - only ancestry_proven=true if you saw ANCESTRY-OK
5. pnpm typecheck (fast post-merge gate; on failure report it — do not revert)`,
      {
        label: `merge-${u.unit_id}`,
        phase: 'Merge',
        effort: 'low',
        schema: {
          type: 'object',
          properties: {
            merged: { type: 'boolean' },
            ancestry_proven: { type: 'boolean' },
            merge_sha: { type: 'string' },
            typecheck_ok: { type: 'boolean' },
            issues: { type: 'array', items: { type: 'string' } },
          },
          required: ['merged', 'ancestry_proven', 'issues'],
        },
      },
    );

    if (merge?.merged && merge.ancestry_proven) {
      mergedUnits.push({ ...u, mergeSha: merge.merge_sha, typecheckOk: merge.typecheck_ok });
      log(`✅ [${u.unit_id}] merged (${merge.merge_sha}) ancestry-proven`);
    } else {
      parked.add(u.unit_id); // conflicts / unprovable merges go straight to a human
      log(`🅿️ [${u.unit_id}] merge failed/unproven — PARKED: ${(merge?.issues ?? []).join('; ')}`);
    }
  }

  // ---- PHASE 8: Cleanup & Progress ----
  phase('Cleanup & Progress');
  await retryAgent(
    `Kvy cycle ${cycleCount} bookkeeping, on branch ${TARGET_BRANCH} (repo root).

MERGED units (ancestry-proven): ${JSON.stringify(mergedUnits.map((u) => ({ id: u.unit_id, sha: u.mergeSha })))}
FAILED/PARKED this cycle: ${JSON.stringify([...parked])}

1. For each MERGED unit: git worktree remove ${WORKTREE_ROOT}/<unit_id> --force
   and git branch -d wf/<unit_id>. Leave failed units' worktrees IN PLACE for
   human inspection.
2. Re-verify each merged unit yourself before ticking anything:
   git merge-base --is-ancestor <sha> ${TARGET_BRANCH} must hold. NEVER tick a
   checkbox you did not verify this way (plan.md §17 false-landing rule).
3. In plan-v2.md's Master TODO: flip verified-merged units' non-[human] sub-boxes
   and the unit box to [x] (leave [human] live-check sub-boxes unchecked).
4. Update/create progress.md: cycle number, merged units + shas, parked units with
   reasons, next 1-2 recommended units.
5. pnpm typecheck on ${TARGET_BRANCH}; report result.
6. Commit plan-v2.md + progress.md: "chore: cycle ${cycleCount} — ${mergedUnits.length} unit(s) landed"`,
    {
      label: 'sync-progress',
      phase: 'Cleanup & Progress',
      effort: 'low',
      schema: {
        type: 'object',
        properties: {
          cycle_passed: { type: 'boolean' },
          summary: { type: 'string' },
          issues: { type: 'array', items: { type: 'string' } },
        },
        required: ['cycle_passed', 'summary', 'issues'],
      },
    },
  );

  log(`Cycle ${cycleCount}: ${mergedUnits.length}/${units.length} landed. Parked: ${[...parked].join(', ') || 'none'}`);
}

log(`\n🏁 Done after ${cycleCount} cycle(s). Parked for human: ${[...parked].join(', ') || 'none'}`);
return { cycles: cycleCount, parked: [...parked] };

// ============ Pipelines ============

// [inline] units: micro-tasks — ONE agent does implement+test+self-review in a
// single pass. The 4-stage pipeline on these is ~95% overhead (plan-v2.md
// "execution units" rationale).
async function runInlineUnit(u) {
  phase('Implementation');
  const result = await retryAgent(
    `You are implementing Kvy inline unit ${u.unit_id} ("${u.title}") — a batch of
micro-tasks — in worktree ${u.wtPath}. ALL work in the worktree (cd first).

SUB-TASKS (do every one; each cites its design section in plan-v2.md — read it):
${u.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Rules: read plan-v2.md's matching wave section for the exact design + snippets;
match surrounding code style; no TODOs; skip sub-tasks marked [human] (live
checks — not yours). Then, in the worktree: pnpm build, run the scoped tests you
added/affected, pnpm typecheck. Write task-summary/${u.unit_id}.md (what/why/
assumptions). Commit: "feat: ${u.unit_id} — ${u.title}". Do NOT merge or push.`,
    {
      label: `inline-${u.unit_id}`,
      phase: 'Implementation',
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          files_changed: { type: 'array', items: { type: 'string' } },
          tests_run: { type: 'number' },
          summary: { type: 'string' },
          errors: { type: 'array', items: { type: 'string' } },
        },
        required: ['success', 'files_changed', 'summary', 'errors'],
      },
    },
  );
  if (!result?.success) {
    log(`❌ [${u.unit_id}] inline unit failed: ${(result?.errors ?? ['agent unavailable']).join('; ')}`);
    return null;
  }
  return { unit_id: u.unit_id, status: 'complete', summary: result.summary };
}

// [bundle]/[solo] units: full implement → test → fix → review pipeline in one
// worktree. A bundle's tasks are co-located by design (shared files), so one
// pipeline covers all of them with one coherent diff.
async function runFullPipeline(u) {
  try {
    phase('Implementation');
    const impl = await retryAgent(
      `You are implementing Kvy ${u.kind} unit ${u.unit_id} ("${u.title}") in
worktree ${u.wtPath}. ALL work in the worktree (cd first).

SUB-TASKS (all of them — they share files on purpose, one coherent change):
${u.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Context: read plan-v2.md's matching wave section FIRST (it contains the settled
design + code snippets grounded in the real source), then CLAUDE.md and the files
themselves. kvy-system-design.md for architecture questions.
PRIOR ATTEMPT: first run \`git log ${TARGET_BRANCH}..HEAD --oneline\` in the
worktree. If commits exist, this unit was partially built before — read
task-summary/${u.unit_id}.md and the diff, verify each sub-task against the
code, and only fill gaps / fix recorded issues. Do NOT start over.
Rules: follow the plan's snippets unless the code has drifted (then adapt +
note it in the summary); additive-only wire changes; no TODOs; skip [human]
sub-tasks. pnpm build must pass in the worktree before you finish.
Write task-summary/${u.unit_id}.md. Commit: "feat: ${u.unit_id} — ${u.title}".
Do NOT merge or push.`,
      {
        label: `impl-${u.unit_id}`,
        phase: 'Implementation',
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            files_created: { type: 'array', items: { type: 'string' } },
            files_modified: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
            errors: { type: 'array', items: { type: 'string' } },
          },
          required: ['success', 'files_created', 'files_modified', 'summary', 'errors'],
        },
      },
    );
    if (!impl?.success) {
      log(`❌ [${u.unit_id}] implementation failed: ${(impl?.errors ?? ['agent unavailable']).join('; ')}`);
      return null;
    }

    phase('Testing');
    const test = await retryAgent(
      `Test Kvy unit ${u.unit_id} in worktree ${u.wtPath} (cd first).
Files changed: ${impl.files_created.concat(impl.files_modified).join(', ')}
Sub-tasks it claims to implement: ${JSON.stringify(u.tasks)}

Write/extend unit tests for the changed behavior (Vitest, co-located, matching
each package's existing test style), then run: pnpm test (full) + pnpm typecheck
in the worktree. Commit new tests: "test: ${u.unit_id}". Report issues found —
do NOT fix implementation code.`,
      {
        label: `test-${u.unit_id}`,
        phase: 'Testing',
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            tests_passed: { type: 'number' },
            tests_failed: { type: 'number' },
            issues_found: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
          },
          required: ['success', 'tests_passed', 'tests_failed', 'issues_found', 'summary'],
        },
      },
    );
    if (!test) return null;
    log(`[${u.unit_id}] tests: ${test.tests_passed}✓ ${test.tests_failed}✗`);

    phase('Review & Fix');
    if (test.issues_found.length > 0) {
      const fix = await retryAgent(
        `Fix these issues in Kvy unit ${u.unit_id}, worktree ${u.wtPath} (cd first):
${test.issues_found.map((x, i) => `${i + 1}. ${x}`).join('\n')}
Root-cause each, fix, re-run affected tests + pnpm typecheck.
Commit: "fix: ${u.unit_id} — resolve test issues". Report anything unfixable.
IMPORTANT: remaining_issues must list ONLY unfixed CODE defects in this unit.
Environment/sandbox problems — e.g. the documented transient biome lint OOM
(CLAUDE.md notes it; it reproduces on the untouched base branch), disk
pressure, stale daemons — go in environment_notes and do NOT block the unit.`,
        {
          label: `fix-${u.unit_id}`,
          phase: 'Review & Fix',
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              remaining_issues: { type: 'array', items: { type: 'string' } },
              environment_notes: { type: 'array', items: { type: 'string' } },
              summary: { type: 'string' },
            },
            required: ['success', 'remaining_issues', 'summary'],
          },
        },
      );
      if (!fix?.success || (fix.remaining_issues?.length ?? 0) > 0) {
        log(`❌ [${u.unit_id}] unfixed issues remain: ${(fix?.remaining_issues ?? ['fix agent unavailable']).join('; ')}`);
        return null;
      }
    }

    const review = await retryAgent(
      `Code-review Kvy unit ${u.unit_id} in worktree ${u.wtPath} (cd first).
Diff scope: git diff ${TARGET_BRANCH}...HEAD
Check: correctness vs the unit's sub-tasks (${JSON.stringify(u.tasks)}); no
silent failures; additive-only wire changes; injection/PTY code never writes to
the PTY outside its gates; TypeScript strictness; matches plan-v2.md's design.
Fix ONLY critical findings (commit "refactor: ${u.unit_id} — review fixes");
document the rest as findings. No large refactors.`,
      {
        label: `review-${u.unit_id}`,
        phase: 'Review & Fix',
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            critical_unfixed: { type: 'array', items: { type: 'string' } },
            findings: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
          },
          required: ['success', 'critical_unfixed', 'findings', 'summary'],
        },
      },
    );
    if (!review?.success || (review.critical_unfixed?.length ?? 0) > 0) {
      log(`❌ [${u.unit_id}] critical review findings unfixed`);
      return null;
    }

    return { unit_id: u.unit_id, status: 'complete', summary: impl.summary, findings: review.findings };
  } catch (err) {
    log(`❌ [${u.unit_id}] pipeline threw: ${err.message}`);
    return null;
  }
}
