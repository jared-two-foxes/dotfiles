export type ScaffoldOperation =
  | "init" | "add" | "list" | "start" | "complete" | "block"
  | "fail" | "retry" | "decompose" | "design-record"
  | "design-finish" | "design-reopen" | "checkpoint-record" | "issue-resume"
  | "summary" | "issue" | "select" | "design-select" | "delivery-record";

export interface IssueBinding {
  featureId: string;
  taskId: string;
  designRef: string;
}

export interface IssueDesign {
  reference: string;
  summary: string;
  verification: string;
  approval: string;
  disposition: "leaf" | "decomposed";
  children: string[];
}

export interface IssueContract {
  id: string;
  objective: string;
  acceptance_criteria: string[];
  constraints: string[];
  dependencies: string[];
  status: "pending" | "in_progress" | "completed" | "blocked" | "failed" | "decomposed";
  design?: IssueDesign;
}

export interface Issue extends IssueContract {
  feature_id: string;
  parent_id: string | null;
  designs: IssueDesign[];
  history: Array<Record<string, unknown>>;
}

export interface Feature {
  id: string;
  design_ref: string;
  context: string;
  objective: string;
  acceptance_criteria: string[];
  constraints?: string[];
  branch: string;
  baseline: string;
  original_baseline: string;
  workflow: { kind: "recursive-issues/v1"; phase: "design" | "implement"; root_id: string };
  tasks: Record<string, Issue>;
}

export interface ScaffoldRequest {
  operation: ScaffoldOperation;
  feature_id: string;
  task_id?: string;
  payload?: unknown;
  reason?: string;
}

export interface FeatureSummary {
  id: string;
  design_ref: string;
  phase: "design" | "implement";
  task_revision: number;
  state_digest: string;
  baseline: string;
  branch: string;
  counts: Record<string, number>;
}

export interface IssueCapsule {
  schema: "scaffold.issue-context/v1";
  feature: FeatureSummary;
  issue: IssueContract;
  ancestors: IssueContract[];
  prerequisites: IssueContract[];
  children: IssueContract[];
}

export interface ScaffoldResponse {
  schema_version: 2;
  feature?: Feature;
  task?: Issue | null;
  summary?: FeatureSummary;
  context?: IssueCapsule | null;
}

export type ScaffoldResult =
  | { ok: true; operation: ScaffoldOperation; feature_id: string; task_id?: string;
      exit_code: 0; data: ScaffoldResponse }
  | { ok: false; operation?: ScaffoldOperation; feature_id?: string; task_id?: string;
      reason: string; message: string; exit_code?: number; stderr?: string };

export const OPERATIONS: ScaffoldOperation[];
export function designReference(context: string): string;
export function validateRequest(params: unknown): ScaffoldRequest;
export function validateResponse(data: unknown, params: ScaffoldRequest): asserts data is ScaffoldResponse;
export function approvedIssue(feature: Feature, binding: IssueBinding): Issue;
export function issueDesignRequirements(task: Issue): string;
export function issueRequirements(task: Issue, additional: string): string;
