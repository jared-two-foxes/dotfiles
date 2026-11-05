# Execute and Review retry policy

Apply these rules after inspecting the failed attempt and before submitting a
correction. The native extension enforces the retry gates using retained
evidence. Continue an allowed, in-scope correction under the existing direction
approval.

## Attempt history and progress

There is no per-issue lifetime attempt limit. Preserve the baseline, criteria,
findings, and consumed attempts across retries and authenticated handoffs.
Resuming after three attempts makes the next run attempt four.

Repeated equivalent substantive failures, a stationary tree and failure scope,
or cycling source states can return `DIAGNOSIS_REQUIRED`. Three equivalent
failures are enough to trigger the gate. Compile → test → new review findings
can demonstrate progress. Changing wording, check labels, or unrelated files
provides no evidence of progress.

When the tool requests diagnosis, use the returned signature in a `diagnose`
context update with a concrete explanation and a changed correction, check
repair, or revised design. The extension allows one such probe per signature.
Use the returned evidence to report a blocker if the diagnosis remains unresolved.

## Infrastructure and resource pauses

- On `INFRASTRUCTURE_PAUSED`, preserve source and evidence and repair the service
  or local configuration. A measured executable or credential-file repair can
  permit continuation. Transient network and provider failures allow a bounded
  caller-driven probe after five minutes.
- After environment-only credential rotation, use `reviewProbe: true` with
  `{"operations":[]}`. A failed probe is throttled for five minutes. Report the
  pause when the next probe is unavailable.
- On `RESOURCE_PAUSED`, retain the prior usage and explicitly revise the
  invocation allowance before resuming. For oversized review context, increase
  `reviewContextMaxBytes` while preserving the original obligations.

Stop for unavailable prerequisites or credentials and unresolved source or
index drift. Preserve the tree and use the applicable recovery action from the
tool. Report the blocker with retained evidence. Retry decisions happen in
Pi's delivery loop without a background scheduler. Only successful execution,
checks, and an approved independent review satisfy the verification gate.
