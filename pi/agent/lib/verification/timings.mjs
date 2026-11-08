// Additive, non-authoritative timing telemetry for retained delivery evidence.
//
// Timings live in a dedicated top-level `timings` field (task and feature
// receipts) or in per-stage sidecar files. They never appear inside `args`,
// `workflow`, `request`, `result`, `checks` or `review`, which authenticators
// compare field by field. Absence is always valid, so receipts written before
// this module existed stay readable and authenticate unchanged.
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const TIMINGS_SCHEMA = "pi.timings/v1";

// Wall-clock stopwatch: `started_at` for humans, monotonic clock for duration.
export function stopwatch() {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  return {
    startedAt,
    elapsed: () => Math.round((performance.now() - t0) * 1000) / 1000,
  };
}

export const timingPath = (receiptPath) =>
  receiptPath.replace(/\.receipt\.json$/, ".timing.json");

async function readRegular(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  return readFile(file, "utf8");
}

// Read the sidecar written by command-stage.mjs for each attempted stage.
// A missing or malformed sidecar yields null for that stage; it never throws.
export async function readStageTimings(root, specs, attempted) {
  const stages = [];
  for (let index = 0; index < attempted; index++) {
    let entry = null;
    try {
      const parsed = JSON.parse(
        await readRegular(path.join(root, `${index}.timing.json`)),
      );
      if (
        parsed?.schema === TIMINGS_SCHEMA &&
        parsed.index === index &&
        Number.isFinite(parsed.duration_ms)
      )
        entry = parsed;
    } catch {}
    stages.push({
      index,
      name: specs[index]?.name ?? null,
      ...(entry
        ? {
            started_at: entry.started_at,
            duration_ms: entry.duration_ms,
            process_ms: entry.process_ms ?? null,
            snapshot_ms: entry.snapshot_ms ?? null,
            snapshot_after_ms: entry.snapshot_after_ms ?? null,
            handoff_ms: entry.handoff_ms ?? null,
            reused: entry.reused === true,
          }
        : { duration_ms: null }),
    });
  }
  return stages;
}

// Scaffold CLI usage spans two processes: Pi's own calls, and the commit child
// process that Conductor launches for sealing and checkpointing. Report the
// total and both parts; a missing child figure is reported as unknown, not zero.
export function combineScaffoldUsage(parent, finalization) {
  const known = Number.isFinite(finalization?.calls) && Number.isFinite(finalization?.totalMs);
  return {
    calls: parent.calls + (known ? finalization.calls : 0),
    totalMs: Math.round((parent.totalMs + (known ? finalization.totalMs : 0)) * 1000) / 1000,
    pi_process: parent,
    finalization_process: known ? finalization : null,
    complete: known,
  };
}

// Number of events the review engine appended to its ledger (a raw count; the
// event vocabulary belongs to review-cli, so no event is interpreted here).
export async function ledgerEventCount(file) {
  try {
    const text = await readRegular(file);
    return text === null ? null : text.split("\n").filter(Boolean).length;
  } catch {
    return null;
  }
}

const sum = (values) =>
  values.reduce((total, v) => total + (Number.isFinite(v) ? v : 0), 0);

// Build the `timings` field for a task receipt from stage sidecars.
export function taskTimings({ stages, ledgerEvents, sealPrepMs, attempt }) {
  const last = stages.length - 1;
  return {
    schema: TIMINGS_SCHEMA,
    kind: "task",
    attempt: attempt ?? null,
    stages,
    // First stage is the executor, last prefix stage is the independent review.
    execution_ms: stages[0]?.duration_ms ?? null,
    checks_ms: sum(stages.slice(1, Math.max(1, last)).map((s) => s.duration_ms)),
    review_ms: last > 0 ? (stages[last]?.duration_ms ?? null) : null,
    seal_prep_ms: sealPrepMs ?? null,
    review_ledger_events: ledgerEvents ?? null,
    missing_stage_timings: stages.filter((s) => s.duration_ms === null).length,
  };
}

// Build the `timings` field for a feature validation record.
export function featureTimings({ checks, reviewMs, totalMs, rechecks }) {
  return {
    schema: TIMINGS_SCHEMA,
    kind: "feature",
    checks,
    checks_ms: sum(checks.map((c) => c.duration_ms)),
    review_ms: reviewMs ?? null,
    // Cost of re-deriving preconditions (SA-611): how often and how long.
    precondition_checks: rechecks.count,
    precondition_ms: Math.round(rechecks.ms * 1000) / 1000,
    total_ms: totalMs,
  };
}

// Human-oriented summary of any retained record, tolerant of old receipts.
export function summarizeTimings(record) {
  const t = record?.timings;
  if (!t || t.schema !== TIMINGS_SCHEMA)
    return { available: false, reason: "Receipt has no timing telemetry" };
  return { available: true, ...t };
}

// Read every task and feature receipt in a repository's evidence directory.
export async function repositoryTimings(evidenceDirectory) {
  const rows = [];
  for (const name of (await readdir(evidenceDirectory)).sort()) {
    if (!/^(feature-)?[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(
        await readFile(path.join(evidenceDirectory, name), "utf8"),
      );
      rows.push({
        file: name,
        recordedAt: record.recordedAt ?? null,
        task: record.task?.taskId ?? record.binding?.feature_id ?? null,
        status: record.result?.status ?? null,
        ...summarizeTimings(record),
      });
    } catch {}
  }
  return rows;
}
