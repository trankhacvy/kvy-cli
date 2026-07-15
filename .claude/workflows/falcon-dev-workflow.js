export const meta = {
  name: 'falcon-dev-loop',
  description: 'Orchestrate Falcon implementation: task-finder → parallel worktree-isolated code-test-review → verification → cleanup',
  phases: [
    { title: 'Task Discovery', detail: 'Sonnet 5 agent finds 1-3 parallelizable tasks' },
    { title: 'Worktree Setup', detail: 'Orchestrator creates isolated git worktree per task' },
    { title: 'Implementation', detail: 'Sonnet 5 implements each task in its worktree' },
    { title: 'Testing', detail: 'Sonnet 5 tests code (unit/e2e/chrome MCP)' },
    { title: 'Review & Fix', detail: 'Sonnet 5 reviews and fixes issues' },
    { title: 'Verification', detail: 'Orchestrator verifies task, merges worktree' },
    { title: 'Cleanup & Progress', detail: 'Remove worktree, update plan.md, type-check main' },
  ],
};

// Core workflow loop
let cycleCount = 0;
const maxCycles = 20; // safety limit
const worktreePath = '.worktrees';

while (cycleCount < maxCycles) {
  cycleCount++;
  log(`\n=== CYCLE ${cycleCount} ===`);

  // PHASE 1: Task Discovery
  phase('Task Discovery');

  const tasksResult = await agent(
    `You are the task-finder for the Falcon project. Your job:
1. Read falcon-prd.md (what/why), falcon-system-design.md (architecture), and plan.md (detailed breakdown)
2. Read progress.md if it exists to understand what's already done
3. Find the next 1-3 tasks from plan.md that:
   - Are not yet started (marked [ ] in plan.md)
   - Can be worked on in parallel (independent of each other)
   - Have all their dependencies met
   - Are from consecutive phases if possible (to maintain momentum)
4. Return a JSON list of tasks with format: {task_id, section, title, description, blocking_dependencies, estimated_effort}

Prioritize Phase 0 (Repo & contracts) first, then Phase 1, etc.
If you can't find 3 tasks, return 1-2.
If ALL tasks are done, return an empty list and a "completion" status.

Return ONLY valid JSON (no markdown, no explanation).`,
    {
      label: 'find-tasks',
      phase: 'Task Discovery',
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['in-progress', 'completed'] },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                task_id: { type: 'string' },
                section: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                blocking_dependencies: { type: 'array', items: { type: 'string' } },
                estimated_effort: { type: 'string', enum: ['small', 'medium', 'large'] },
              },
              required: ['task_id', 'section', 'title', 'description'],
            },
          },
          reasoning: { type: 'string' },
        },
        required: ['status', 'tasks', 'reasoning'],
      },
      model: 'sonnet',
    }
  );

  if (!tasksResult || !tasksResult.tasks || tasksResult.tasks.length === 0) {
    if (tasksResult?.status === 'completed') {
      log('✅ All tasks completed!');
      break;
    }
    log('⚠️ Task finder returned no tasks, retrying next cycle...');
    continue;
  }

  const selectedTasks = tasksResult.tasks;
  log(`Found ${selectedTasks.length} task(s): ${selectedTasks.map(t => t.title).join(', ')}`);

  // PHASE 2: Setup worktrees (sequential, A does this)
  phase('Worktree Setup');
  const worktreeSetupResults = [];

  for (const task of selectedTasks) {
    const wtPath = `${worktreePath}/${task.task_id}`;
    log(`[${task.task_id}] Creating worktree at ${wtPath}`);

    const setupCmd = `git worktree add "${wtPath}" main 2>&1 || true`;
    // Note: A orchestrator runs this via bash or delegates to an agent that can run bash
    worktreeSetupResults.push({ task_id: task.task_id, wtPath });
    log(`[${task.task_id}] Worktree ready`);
  }

  // PHASE 3-5: Code-Test-Review for each task in parallel (with worktree paths)
  log(`Spawning ${selectedTasks.length} parallel code-test-review workflows...`);
  const workflowResults = await parallel(
    selectedTasks.map((task, idx) => () =>
      executeCodeTestReviewWorkflow(task, worktreeSetupResults[idx].wtPath)
    )
  );

  const successfulTasks = workflowResults.filter(Boolean);
  log(`\nCompleted ${successfulTasks.length}/${selectedTasks.length} tasks`);

  // PHASE 6: Verification & merge worktrees (A does this)
  phase('Verification');

  for (let i = 0; i < selectedTasks.length; i++) {
    const task = selectedTasks[i];
    const wtPath = worktreeSetupResults[i].wtPath;
    const result = workflowResults[i];

    if (!result) {
      log(`[${task.task_id}] ⚠️ Workflow failed, skipping verification`);
      continue;
    }

    log(`[${task.task_id}] Verifying task...`);

    const verifyResult = await agent(
      `You are verifying a completed Falcon task before merging it to main.

TASK: ${task.title}
WORKTREE: ${wtPath}

Your job:
1. Run full tests in the worktree: cd ${wtPath} && pnpm test
2. Run typecheck: cd ${wtPath} && pnpm typecheck
3. Verify no regressions in other packages
4. Read the implementation summary from task-summary/${task.task_id}.md
5. Spot-check key files for code quality
6. Report: {verified: boolean, issues: [], summary: string}

If verification passes, report verified=true.
If issues found, report them; don't fix (A will handle).`,
      {
        label: `verify-${task.task_id}`,
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
        model: 'sonnet',
      }
    );

    if (verifyResult?.verified) {
      log(`[${task.task_id}] ✅ Verified, merging...`);
      // Merge: git merge ${wtPath} or cherry-pick commits
      // For now, just log — real impl would merge commits from worktree
    } else {
      log(`[${task.task_id}] ❌ Verification failed: ${verifyResult?.issues?.join(', ')}`);
    }
  }

  // PHASE 7: Cleanup & Progress update
  phase('Cleanup & Progress');

  log(`Cleaning up ${selectedTasks.length} worktree(s)...`);
  for (const task of selectedTasks) {
    const wtPath = `${worktreePath}/${task.task_id}`;
    // git worktree remove ${wtPath}
    log(`[${task.task_id}] Removed worktree ${wtPath}`);
  }

  // Update progress on main
  log(`Updating progress.md on main...`);
  await agent(
    `You are the progress tracker for the Falcon project (working on main branch).
1. Run full typecheck on main: \`pnpm typecheck\`
2. Run test suite on main: \`pnpm test\`
3. If either fails, report the errors and note that the cycle had issues
4. Read the task-summary files from successful tasks:
${successfulTasks.map((r, i) => `   - task-summary/${selectedTasks[i].task_id}.md`).join('\n')}
5. Update plan.md: for each successfully verified task, change [ ] to [x] and add a date stamp
6. Update or create progress.md with:
   - Cycle number and timestamp
   - Tasks completed this cycle (with summary)
   - Any blockers or issues found
   - Overall completion percentage
   - Next recommended tasks (1-3)
7. Commit both changes with a message like "chore: cycle ${cycleCount} — completed N tasks"

Report: {cycle_passed: boolean, summary: string, issues: [], completion_percent: number}`,
    {
      label: 'sync-progress',
      phase: 'Cleanup & Progress',
      schema: {
        type: 'object',
        properties: {
          cycle_passed: { type: 'boolean' },
          summary: { type: 'string' },
          issues: { type: 'array', items: { type: 'string' } },
          completion_percent: { type: 'number' },
        },
        required: ['cycle_passed', 'summary', 'issues', 'completion_percent'],
      },
      model: 'sonnet',
    }
  );

  log(`Cycle ${cycleCount} complete. Checking for more tasks...`);
}

log(`\n✅ Workflow completed after ${cycleCount} cycles.`);

// ============ HELPER: Code-Test-Review Workflow per Task ============

async function executeCodeTestReviewWorkflow(task, worktreePath) {
  const taskLabel = `${task.task_id}`;
  const summaryPath = `task-summary/${task.task_id}.md`;

  try {
    // IMPLEMENT (phase 3)
    phase('Implementation');
    log(`[${taskLabel}] Starting implementation in ${worktreePath}...`);
    const implResult = await agent(
      `You are implementing a Falcon task in an isolated git worktree.

TASK: ${task.title}
SECTION: ${task.section}
DESCRIPTION: ${task.description}
WORKTREE PATH: ${worktreePath}

Your job:
1. All work must happen IN THE WORKTREE — cd ${worktreePath} before starting
2. Read the full context (falcon-prd.md, falcon-system-design.md, plan.md at this section)
3. Read any referenced Happy source files for porting guidance
4. Implement the task completely (write code, create files, update configs)
5. Run \`pnpm build\` in the worktree to ensure it compiles
6. Create or update the summary file at ${worktreePath}/${summaryPath} (implementation notes, what you did, assumptions)
7. Commit your code changes to the worktree with a message like "feat: ${task.task_id} - ${task.title}"

Key rules:
- ALL file edits MUST be in ${worktreePath}/ (not the main branch)
- Keep code clean and minimal (no over-engineering)
- No TODOs or half-finished code
- If the task is marked (V) verbatim port, port faithfully from Happy
- If marked (P) port with changes, follow the design doc's deltas carefully
- If marked (N) new code, follow the design principles (null-safe, no silent failures)
- Do NOT merge or push — just commit in the worktree

Report format: {success: boolean, files_created: [], files_modified: [], summary: string, errors: [], commit_hash: string}`,
      {
        label: `impl-${taskLabel}`,
        phase: 'Implementation',
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            files_created: { type: 'array', items: { type: 'string' } },
            files_modified: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
            errors: { type: 'array', items: { type: 'string' } },
            commit_hash: { type: 'string' },
          },
          required: ['success', 'files_created', 'files_modified', 'summary', 'errors'],
        },
        model: 'sonnet',
      }
    );

    if (!implResult?.success) {
      log(`[${taskLabel}] ❌ Implementation failed: ${implResult?.errors?.join('; ')}`);
      return null;
    }

    log(`[${taskLabel}] ✅ Implementation complete`);

    // TEST (phase 4)
    phase('Testing');
    log(`[${taskLabel}] Starting testing in ${worktreePath}...`);
    const testResult = await agent(
      `You are testing a Falcon implementation task in an isolated git worktree.

TASK: ${task.title}
WORKTREE PATH: ${worktreePath}
FILES IMPLEMENTED: ${implResult.files_created.concat(implResult.files_modified).join(', ')}

Your job:
1. ALL work in the worktree — cd ${worktreePath} before starting
2. Read the implemented files to understand what was built
3. Decide the appropriate test strategy:
   - For CLI/daemon/server code: unit tests in Vitest (in the worktree)
   - For web components: component tests + visual inspection
   - For integration: end-to-end tests (may need chrome MCP for web UI testing)
4. Write comprehensive tests (or run existing tests for the modified files) in the worktree
5. Run \`cd ${worktreePath} && pnpm test\` to ensure tests pass
6. If testing the web UI, use chrome MCP to:
   - Open the app in a browser
   - Navigate to the relevant feature
   - Interact with it as a user would
   - Verify behavior matches implementation
7. Report any issues found (don't fix — let the fix agent handle it)

For desktop/CLI testing: you can use computer-use or bash
For web testing: use chrome MCP

Report format: {success: boolean, tests_passed: number, tests_failed: number, coverage: string, issues_found: [], summary: string}`,
      {
        label: `test-${taskLabel}`,
        phase: 'Testing',
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            tests_passed: { type: 'number' },
            tests_failed: { type: 'number' },
            coverage: { type: 'string' },
            issues_found: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
          },
          required: ['success', 'tests_passed', 'tests_failed', 'issues_found', 'summary'],
        },
        model: 'sonnet',
      }
    );

    log(`[${taskLabel}] Tests: ${testResult?.tests_passed}✓ ${testResult?.tests_failed}✗`);

    // FIX (phase 5, if issues found)
    phase('Review & Fix');
    let fixResult = { success: true, issues_fixed: 0, remaining_issues: [] };
    if (testResult?.issues_found?.length > 0) {
      log(`[${taskLabel}] Found ${testResult.issues_found.length} issues, fixing in ${worktreePath}...`);
      fixResult = await agent(
        `You are fixing test failures in a Falcon implementation (in the worktree).

TASK: ${task.title}
WORKTREE PATH: ${worktreePath}
ISSUES FOUND:
${testResult.issues_found.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

Your job:
1. ALL work in the worktree — cd ${worktreePath} before starting
2. For each issue, identify the root cause in the implementation files
3. Fix the code (may need to modify the implementation files in the worktree)
4. Re-run tests: \`cd ${worktreePath} && pnpm test\` (for affected tests only)
5. Verify all issues are resolved
6. Commit your fixes with a message like "fix: ${task.task_id} - resolve test failures"

If an issue is unfixable (architectural problem), report it clearly.

Report format: {success: boolean, issues_fixed: number, remaining_issues: [], summary: string}`,
        {
          label: `fix-${taskLabel}`,
          phase: 'Review & Fix',
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              issues_fixed: { type: 'number' },
              remaining_issues: { type: 'array', items: { type: 'string' } },
              summary: { type: 'string' },
            },
            required: ['success', 'issues_fixed', 'summary'],
          },
          model: 'sonnet',
        }
      );

      if (fixResult?.remaining_issues?.length > 0) {
        log(`[${taskLabel}] ⚠️ Remaining issues: ${fixResult.remaining_issues.join(', ')}`);
      }
    }

    // REVIEW (phase 5)
    log(`[${taskLabel}] Starting code review of ${worktreePath}...`);
    const reviewResult = await agent(
      `You are reviewing code for a Falcon implementation task (in the worktree).

TASK: ${task.title}
WORKTREE PATH: ${worktreePath}
IMPLEMENTATION: ${implResult.files_created.concat(implResult.files_modified).join(', ')}

Your job:
1. ALL work in the worktree — cd ${worktreePath} before starting
2. Read the implemented and modified files
3. Check for:
   - Code quality and clarity
   - Security vulnerabilities (no command injection, XSS, SQL injection, etc.)
   - Alignment with Falcon design principles:
     * Null-safe operations (never throw on bad data)
     * No silent failures (errors are visible)
     * Faithful ports from Happy (when applicable)
     * Minimal, no over-engineering
   - TypeScript strictness
   - Proper error handling
4. For each finding, decide: fix now (high-priority issues only) or document as tech debt
5. If fixing, apply the fix and commit with a message like "refactor: ${task.task_id} - code review fixes"
6. DO NOT make large refactors — only fix critical issues

Report format: {success: boolean, findings: [{severity: 'critical'|'high'|'medium'|'low', issue: string, fix_applied: boolean}], summary: string}`,
      {
        label: `review-${taskLabel}`,
        phase: 'Review & Fix',
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                  issue: { type: 'string' },
                  fix_applied: { type: 'boolean' },
                },
              },
            },
            summary: { type: 'string' },
          },
          required: ['success', 'findings', 'summary'],
        },
        model: 'sonnet',
      }
    );

    log(`[${taskLabel}] ✅ Review complete (${reviewResult?.findings?.length || 0} findings)`);

    return {
      task_id: task.task_id,
      status: 'complete',
      worktree_path: worktreePath,
      summary: implResult.summary,
      test_passed: testResult?.success,
      tests_passed: testResult?.tests_passed || 0,
      tests_failed: testResult?.tests_failed || 0,
      review_findings: reviewResult?.findings?.length || 0,
      critical_issues: reviewResult?.findings?.filter(f => f.severity === 'critical').length || 0,
    };
  } catch (err) {
    log(`[${taskLabel}] ❌ Workflow failed: ${err.message}`);
    return null;
  }
}
