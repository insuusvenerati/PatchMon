# Bulk host package updates (local fork)

## Objective and scope

Select individual hosts, a page, or all hosts matching the current filters from
**Hosts**, then choose **Update Packages**. Selection persists across pages.
The existing patch wizard updates all system packages on each selected host:

- **Run immediately** applies to every host, or timing can follow each host's
  assigned patch policy.
- **Submit for approval** queues updates without executing them until approved
  from **Patching → Runs & History**.
- Review targets before submitting. Per-host failures remain in the wizard;
  retrying does not resubmit successful hosts.
- Windows hosts are excluded with a notice; use Windows Update or WinGet instead.
- Successful hosts leave the selection; failed/skipped hosts remain selected.

This does not introduce automatic reboots, serial fleet execution, a new
scheduler, API endpoints, schema changes, dependencies, or licensing changes.
Existing permissions, patching entitlements and active-run guards still apply.

## Implementation and verification

React/TanStack Query UI lives in `frontend/src/pages/Hosts.jsx`. Bulk host
retrieval lives in `frontend/src/utils/bulkHosts.js`, using the shared API client
and bounded pagination (500 hosts per page; selected-ID requests in batches of
200). Fetch failures or inconsistent pages must not silently select a partial
fleet. A filter change or cleared selection discards an in-flight selection.

Style follows neighbouring code, for example:

```js
queryClient.invalidateQueries({ queryKey: ["patching-runs"] });
```

Vitest tests in `frontend/src/__tests__/` cover paginated selection, filter
scope, failure handling, wizard targets and update/approval submission.

From the repository root:

```sh
npm run test:run --workspace=frontend
npm run lint
npm run build --workspace=frontend
npm run dev:frontend
```

Always preserve session/activity semantics and refresh host scope after updates.
Never execute real fleet updates as part of automated UI verification. Database,
agent and CI changes are outside scope and require a separate decision.

AI-assisted implementation and tests; human review is still required before
production use. This is a local-fork feature, not an upstream submission.

## Verification results

- Frontend suite: 377 tests passed; 3 existing tests skipped.
- Repository lint and frontend production build passed. The build retains its
  large-chunk warning.
- Browser inspection with mocked hosts confirmed named selection controls,
  44px action targets, no horizontal page overflow at 1000px, and no console
  warnings during inspection. Click/screenshot tools were unavailable because
  the desktop browser window was not visible; visual and keyboard verification
  remains for human review.
- No real host updates were executed. The server and agents were unchanged;
  execution on a running fleet has not been verified.
