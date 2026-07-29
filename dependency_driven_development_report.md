# Dependency Driven Development
## A Contract-Driven, Dependency-Ordered Approach to AI-Assisted Software Development

**Version:** 0.2 (Concept Report)  
**Status:** Draft methodology proposal

---

## Executive Summary

Large language models have dramatically reduced the cost of generating source code. They have not, however, reduced the difficulty of reasoning about entire software systems. As projects grow, AI agents commonly encounter context overload, incorrect assumptions, architectural drift, and cascading implementation errors.

This report proposes **Dependency Driven Development (DDD)** as a methodology for AI-assisted software engineering.

Dependency Driven Development combines:

- **Contract-driven development** to define required behaviour.
- **Dependency graph traversal** to determine implementation order.
- **Discrete verification boundaries** to constrain reasoning scope.
- **Compositional verification** to accumulate confidence incrementally.
- **Explicit separation of contracts, implementations, and evidence** so that claims about correctness remain inspectable and testable.

Rather than asking an AI agent to reason about an entire repository simultaneously, development proceeds from the lowest-level dependencies upward. Each dependency must satisfy an explicit contract before downstream components may rely upon it.

The central principle is:

> A component should never depend upon another component's implementation. It should depend upon an accepted contract supported by explicit evidence.

As development progresses, accepted contracts cascade upward through the dependency graph, allowing larger behaviours to be constructed from smaller, independently verified components.

---

## 1. Motivation

Modern AI coding assistants are often given a ticket such as:

> Implement feature X.

The agent must then reason about the following at once:

- existing architecture
- database schema
- APIs
- tests
- business logic
- dependencies
- external integrations
- unrelated repository conventions

This creates several recurring problems.

### 1.1 Context overload

The larger the repository, the larger the reasoning surface.

An agent that must understand thousands of lines across many layers is more likely to:

- miss constraints
- invent assumptions
- edit unrelated code
- misunderstand ownership boundaries
- produce locally plausible but globally incorrect changes

### 1.2 Cascading errors

If an early assumption is incorrect, every downstream layer may become internally consistent while remaining wrong.

```text
Repository assumption
        │
        ▼
Application service
        │
        ▼
HTTP endpoint
        │
        ▼
Frontend behaviour
```

The later code may compile and pass tests written against the same mistaken assumption.

### 1.3 Large blast radius

A low-level change often causes an AI agent to reopen or regenerate multiple unrelated layers. This makes review harder and increases the risk of accidental regressions.

### 1.4 Weak definitions of correctness

Compilation proves useful properties, but not behavioural correctness.

A project can compile successfully while still containing:

- incorrect algorithms
- incorrect business rules
- incorrect API assumptions
- invalid state transitions
- missing validation
- security flaws
- broken interactions between individually valid components

Dependency Driven Development therefore treats compilation as one form of evidence, not as proof of correctness.

---

## 2. Core Philosophy

Dependency Driven Development is based on six principles.

### Principle 1 — Every meaningful component has a contract

A contract defines observable behaviour rather than implementation details.

For example:

```text
InvoiceRepository::find_invoice

Inputs
------
TenantId
InvoiceId

Outputs
-------
Invoice or NotFound

Errors
------
DatabaseFailure

Guarantees
----------
Never returns an invoice belonging to another tenant.
Does not mutate stored data.
```

Consumers rely upon this contract, not upon the repository's SQL implementation.

### Principle 2 — Dependencies determine implementation order

Implementation follows the dependency graph from foundational components toward higher-level consumers.

```text
Domain types
    ↓
Domain rules
    ↓
Repository traits
    ↓
Repository implementations
    ↓
Application services
    ↓
Transport adapters
    ↓
User-facing feature
```

Lower-level components become accepted building blocks before dependent components are generated.

### Principle 3 — Verification is local

When implementing a component, the active reasoning scope should contain only:

- the current component
- its contract
- the contracts of its direct dependencies
- the evidence required for acceptance

The agent should not casually reopen accepted dependency implementations.

### Principle 4 — Contracts cascade upward

Once a dependency is accepted, downstream components inherit its guarantees.

For example:

```text
SignatureVerifier
        ↓
WebhookParser
        ↓
InvoiceService
        ↓
WebhookEndpoint
```

The endpoint does not need to understand HMAC verification. It depends upon a contract such as:

```text
Input:
Raw request body and signature header

Output:
VerifiedPayload

Guarantee:
The payload was authenticated according to the provider's signing protocol.
```

### Principle 5 — Correctness is compositional

At each step, the system verifies:

```text
Current component
+
Accepted dependency contracts
+
Correct use of those contracts
```

rather than attempting to re-prove the entire system.

### Principle 6 — Contracts, implementations, and evidence are separate artefacts

This is a critical distinction.

A mature Dependency Driven Development workflow should represent three independent artefacts for every component:

#### Contract

The contract states what the component must do.

```yaml
component: TaskRepository.insert
inputs:
  - task
outputs:
  - stored_task
errors:
  - duplicate_task
  - database_failure
guarantees:
  - insert is atomic
  - task identifiers are unique
  - tenant boundaries are preserved
```

#### Implementation

The implementation is the concrete code that attempts to satisfy the contract.

```rust
pub async fn insert(
    &self,
    tenant_id: TenantId,
    task: NewTask,
) -> Result<Task, RepositoryError> {
    // PostgreSQL implementation
}
```

#### Evidence

Evidence records why the implementation is believed to satisfy the contract.

```yaml
component: TaskRepository.insert
contract_version: 2
evidence:
  compile:
    status: passed
  clippy:
    status: passed
  integration_tests:
    - inserts_task_atomically
    - rejects_duplicate_task_id
    - prevents_cross_tenant_access
  database_constraints:
    - unique_task_id
    - task_tenant_foreign_key
unproven:
  - behaviour during database failover
  - performance above 1,000 concurrent writes
```

This separation prevents several dangerous shortcuts:

- treating documentation as proof
- treating implementation as specification
- treating passing tests as complete correctness
- treating a contract as accepted without evidence

The relationship is:

```text
Contract
   │
   ▼
Implementation
   │
   ▼
Evidence
   │
   ▼
Acceptance decision
```

A component is not complete merely because code exists. It is complete when the contract, implementation, and supporting evidence agree sufficiently for the project's acceptance policy.

---

## 3. Formal Shape of the Reasoning

Suppose component `B` depends upon component `A`.

Let:

- `C_A` be the contract for `A`
- `C_B` be the contract for `B`
- `I_A` be the implementation of `A`
- `I_B` be the implementation of `B`
- `E_A` and `E_B` be their respective evidence bundles

The reasoning is:

```text
Evidence E_A supports that implementation I_A satisfies contract C_A.
Implementation I_B satisfies its own local obligations.
Implementation I_B uses contract C_A correctly.
----------------------------------------------------------
Evidence E_B supports that implementation I_B satisfies contract C_B.
```

This pattern repeats upward through the dependency graph.

Correctness does not transfer automatically. What cascades is a bounded set of accepted guarantees.

---

## 4. Fictional Rust Project Example

Consider a fictional Rust SaaS named **TaskForge**.

TaskForge receives GitHub webhooks and creates internal work items.

### 4.1 Repository structure

```text
taskforge/
├── crates/
│   ├── domain/
│   ├── github_adapter/
│   ├── repositories/
│   ├── application/
│   └── http_api/
└── migrations/
```

### 4.2 Dependency graph

```text
GitHubSignatureVerifier
        ↓
GitHubWebhookParser
        ↓
TaskRepository
        ↓
TaskService
        ↓
WebhookEndpoint
```

Development proceeds from the lowest unblocked dependency upward.

---

## 5. Stage One — Signature Verification

### 5.1 Contract

```yaml
component: GitHubSignatureVerifier
inputs:
  - raw_body: bytes
  - signature_header: string
  - webhook_secret: secret
outputs:
  - verified_payload: bytes
errors:
  - missing_signature
  - malformed_signature
  - invalid_signature
guarantees:
  - verifies the raw, unmodified request body
  - rejects invalid signatures
  - uses constant-time signature comparison
  - returns the original payload unchanged
```

### 5.2 Implementation

```rust
pub struct VerifiedPayload(Vec<u8>);

pub fn verify_signature(
    raw_body: &[u8],
    signature_header: &str,
    secret: &[u8],
) -> Result<VerifiedPayload, SignatureError> {
    // HMAC verification omitted for brevity.
    todo!()
}
```

### 5.3 Evidence

```yaml
evidence:
  compile:
    status: passed
  tests:
    - accepts_known_valid_signature
    - rejects_modified_payload
    - rejects_missing_signature
    - rejects_malformed_signature
  security_review:
    - raw body is verified before deserialization
    - constant-time comparison is used
unproven:
  - resistance to side-channel leakage outside comparison logic
```

Only once the signature verifier is accepted may downstream code rely upon `VerifiedPayload`.

---

## 6. Stage Two — Webhook Parsing

The parser depends upon `VerifiedPayload`, not upon raw unauthenticated bytes.

### 6.1 Contract

```yaml
component: GitHubWebhookParser
inputs:
  - verified_payload
  - event_name
outputs:
  - github_event
errors:
  - malformed_json
  - unsupported_event
  - invalid_schema
guarantees:
  - never parses unauthenticated input
  - preserves provider event identifiers
  - rejects unsupported event types explicitly
```

### 6.2 Rust interface

```rust
pub enum GitHubEvent {
    IssueOpened(IssueOpenedEvent),
    PullRequestOpened(PullRequestOpenedEvent),
}

pub fn parse_event(
    payload: VerifiedPayload,
    event_name: &str,
) -> Result<GitHubEvent, ParseError> {
    todo!()
}
```

The parser does not reimplement HMAC verification. It trusts the accepted contract of `VerifiedPayload` and focuses only on schema and event interpretation.

---

## 7. Stage Three — Repository Behaviour

### 7.1 Contract

```yaml
component: TaskRepository
operations:
  insert:
    inputs:
      - tenant_id
      - new_task
    outputs:
      - stored_task
    errors:
      - duplicate_external_event
      - database_failure
    guarantees:
      - insertion is atomic
      - duplicate provider events do not create duplicate tasks
      - tenant isolation is preserved
```

### 7.2 Rust trait

```rust
#[async_trait::async_trait]
pub trait TaskRepository: Send + Sync {
    async fn insert_from_event(
        &self,
        tenant_id: TenantId,
        event_id: ExternalEventId,
        task: NewTask,
    ) -> Result<Task, RepositoryError>;
}
```

### 7.3 PostgreSQL implementation evidence

```yaml
evidence:
  integration_tests:
    - inserts_task
    - rolls_back_partial_write
    - duplicate_event_is_idempotent
    - cannot_write_to_another_tenant
  schema_constraints:
    - unique_tenant_event_id
    - task_tenant_foreign_key
  transaction_boundary:
    - one SQL transaction per insert
```

The service layer may now rely on idempotent persistence without understanding the SQL statements or transaction implementation.

---

## 8. Stage Four — Application Service

### 8.1 Contract

```yaml
component: TaskService
inputs:
  - tenant_id
  - github_event
outputs:
  - task_creation_result
errors:
  - unsupported_business_case
  - persistence_failure
guarantees:
  - issue-opened events create one task
  - pull requests labelled "ignore" create no task
  - duplicate provider events are harmless
```

### 8.2 Rust implementation

```rust
pub struct TaskService<R>
where
    R: TaskRepository,
{
    repository: R,
}

impl<R> TaskService<R>
where
    R: TaskRepository,
{
    pub async fn handle_event(
        &self,
        tenant_id: TenantId,
        event: GitHubEvent,
    ) -> Result<TaskCreationResult, ServiceError> {
        match event {
            GitHubEvent::IssueOpened(issue) => {
                let task = NewTask::from(issue);
                self.repository
                    .insert_from_event(tenant_id, task.event_id(), task)
                    .await
                    .map(TaskCreationResult::Created)
                    .map_err(ServiceError::from)
            }
            GitHubEvent::PullRequestOpened(pr) if pr.labels.contains("ignore") => {
                Ok(TaskCreationResult::Ignored)
            }
            GitHubEvent::PullRequestOpened(pr) => {
                let task = NewTask::from(pr);
                self.repository
                    .insert_from_event(tenant_id, task.event_id(), task)
                    .await
                    .map(TaskCreationResult::Created)
                    .map_err(ServiceError::from)
            }
        }
    }
}
```

The service focuses only on business decisions. It assumes:

- events are authentic
- event payloads are structurally valid
- repository writes are tenant-safe and idempotent

Those guarantees come from accepted dependency contracts.

---

## 9. Stage Five — HTTP Endpoint

### 9.1 Contract

```yaml
component: WebhookEndpoint
inputs:
  - HTTP request
outputs:
  - HTTP response
guarantees:
  - invalid signatures return 401
  - malformed payloads return 400
  - accepted events return 202
  - duplicate events remain successful
  - internal failures return 500 without leaking secrets
```

### 9.2 Rust handler

```rust
pub async fn github_webhook(
    headers: HeaderMap,
    body: Bytes,
    state: State<AppState>,
) -> Result<StatusCode, ApiError> {
    let signature = headers
        .get("x-hub-signature-256")
        .ok_or(ApiError::Unauthorized)?;

    let verified = verify_signature(
        &body,
        signature.to_str().map_err(|_| ApiError::Unauthorized)?,
        state.github_webhook_secret.as_bytes(),
    )?;

    let event_name = headers
        .get("x-github-event")
        .ok_or(ApiError::BadRequest)?
        .to_str()
        .map_err(|_| ApiError::BadRequest)?;

    let event = parse_event(verified, event_name)?;

    state
        .task_service
        .handle_event(state.tenant_id, event)
        .await?;

    Ok(StatusCode::ACCEPTED)
}
```

The endpoint is small because it composes accepted behaviours rather than reimplementing them.

---

## 10. Verification Model

Each dependency node should define an acceptance policy appropriate to its risk.

```text
Contract defined
      ↓
Implementation generated
      ↓
Compilation
      ↓
Static analysis
      ↓
Unit tests
      ↓
Property tests
      ↓
Integration tests
      ↓
Security or architecture checks
      ↓
Evidence bundle produced
      ↓
Accepted or rejected
```

Not every component requires every evidence type.

Examples:

- pure domain logic may rely on unit and property tests
- database repositories may require real PostgreSQL integration tests
- external adapters may require official fixtures and protocol tests
- security-sensitive code may require manual review and known test vectors
- HTTP endpoints may require end-to-end tests

---

## 11. Advantages

### 11.1 Smaller reasoning scope

Agents reason about a single node and its direct contracts rather than an entire repository.

### 11.2 Better AI reliability

Narrower context can reduce:

- hallucinated APIs
- accidental architectural changes
- duplicated logic
- inconsistent assumptions

### 11.3 Reduced blast radius

When a component changes, only that component and affected downstream dependants need to be reopened.

### 11.4 Explicit architecture

Dependency graphs and contracts become first-class project artefacts. Hidden coupling and cyclic dependencies become easier to detect.

### 11.5 Stronger interfaces

Because downstream work depends entirely upon contracts, ambiguous boundaries become obvious. This encourages:

- richer domain types
- explicit errors
- clear invariants
- better ownership boundaries

### 11.6 Better testing discipline

Tests become evidence for contract claims rather than merely exercises of implementation paths.

### 11.7 Better agent orchestration

Different agents can be specialised:

```text
Repository analyst
      ↓
Contract author
      ↓
Contract reviewer
      ↓
Implementation agent
      ↓
Verification agent
      ↓
Integration reviewer
```

### 11.8 Incremental confidence

Confidence grows node by node rather than appearing only at the end of a large feature implementation.

### 11.9 Improved auditability

The separation of contract, implementation, and evidence makes it possible to answer:

- What was this component supposed to do?
- Which code claims to implement it?
- Why was it accepted?
- Which behaviours remain unproven?

This is especially valuable for AI-generated changes.

---

## 12. Disadvantages and Risks

### 12.1 Upfront cost

Writing or deriving contracts requires effort. Early implementation may appear slower than immediately generating code.

### 12.2 Poor contracts can institutionalise mistakes

An incorrect contract can propagate an incorrect assumption throughout the dependency graph.

Contracts therefore require adversarial review, examples, and traceability to requirements.

### 12.3 Integration failures remain possible

Two components may satisfy their local contracts while still composing incorrectly.

Example:

```text
PricingRepository
Returns prices excluding GST.

InvoiceService
Assumes prices include GST.
```

The mismatch may not be detected by isolated tests. Integration checkpoints remain essential.

### 12.4 False confidence from evidence

Passing tests do not constitute mathematical proof. Evidence is always bounded by what was checked.

Every evidence bundle should record unknown or unverified behaviours.

### 12.5 Legacy repositories may lack boundaries

Existing systems may have:

- circular dependencies
- shared mutable state
- hidden side effects
- weak types
- business logic embedded in transport or persistence code

Adopting the methodology may require refactoring before meaningful contracts can be established.

### 12.6 Contract maintenance overhead

Contracts must evolve alongside behaviour. Stale contracts are worse than absent contracts because they create misplaced trust.

### 12.7 Risk of excessive granularity

Contracting every private helper can create bureaucracy and noise.

Contracts should generally be assigned to meaningful architectural boundaries such as:

- public traits
- application services
- repositories
- external adapters
- domain operations
- transport handlers
- transaction boundaries

### 12.8 Bottom-up ordering can conflict with product discovery

In some product work, requirements are uncertain and benefit from prototypes. Strictly defining low-level contracts too early can freeze incorrect assumptions.

Dependency Driven Development should therefore allow exploratory spikes that are explicitly marked as non-accepted and non-contractual.

---

## 13. Managing Contract Quality

A generated or handwritten contract should not be treated as authoritative merely because it exists.

Useful contract fields include:

```yaml
preconditions:
postconditions:
invariants:
side_effects:
errors:
idempotency:
security_assumptions:
performance_expectations:
concurrency_assumptions:
external_protocol_version:
```

Contracts should also include concrete examples.

```yaml
examples:
  - given: a valid issue-opened event
    when: the service processes it
    then: exactly one task is created

  - given: the same event is delivered twice
    when: both deliveries are processed
    then: only one task exists
```

Examples help prevent different layers from attaching different meanings to the same abstract wording.

---

## 14. Confidence and Acceptance Levels

A boolean `correct: true` is too strong and too vague.

A better model records confidence relative to evidence.

```yaml
confidence_levels:
  mechanically_enforced:
    meaning: guaranteed by types, schema constraints, or compiler rules

  verified:
    meaning: directly supported by reliable automated tests

  strongly_inferred:
    meaning: consistently implied by implementation and callers

  intended:
    meaning: stated by requirements but not yet verified

  unknown:
    meaning: insufficient or contradictory evidence
```

Example:

```yaml
claims:
  - statement: duplicate webhook events create only one task
    confidence: verified
    evidence:
      - duplicate_event_is_idempotent
      - unique_tenant_event_id constraint

  - statement: processing remains correct during database failover
    confidence: unknown
    evidence: []
```

---

## 15. Integration Checkpoints

Local verification is necessary but not sufficient.

The dependency graph should include explicit composition checkpoints.

```text
Signature verifier accepted
Parser accepted
        ↓
Checkpoint: verifier + parser

Repository accepted
Service accepted
        ↓
Checkpoint: service + real repository

Endpoint accepted
        ↓
Checkpoint: HTTP + service + repository

Feature complete
        ↓
End-to-end workflow test
```

These checkpoints validate that contracts are complete and consistently interpreted.

---

## 16. Change Propagation

When a contract changes, the system should invalidate affected dependants.

For example:

```text
TaskRepository contract changes
        ↓
TaskService must be re-verified
        ↓
WebhookEndpoint may require re-verification
```

An implementation-only change that preserves the contract may require only local evidence renewal.

This creates a useful distinction:

```text
Implementation changed, contract unchanged
→ re-verify node locally

Contract changed
→ re-open affected downstream dependency slice
```

This resembles incremental compilation, but applied to behavioural correctness.

---

## 17. Relationship to Existing Practices

Dependency Driven Development combines ideas from established disciplines.

| Existing concept | Contribution |
|---|---|
| Design by Contract | Behavioural obligations and guarantees |
| Clean Architecture | Controlled dependency direction |
| Hexagonal Architecture | Explicit ports and adapters |
| Bottom-Up Development | Inside-out implementation order |
| Compositional Verification | Reasoning from component properties |
| Consumer-Driven Contract Testing | Validation of dependency assumptions |
| Property-Based Testing | Broad behavioural evidence |
| Proof-Carrying Code | Association between artefacts and correctness evidence |
| Incremental Builds | Reprocessing only invalidated dependency slices |
| Type-Driven Development | Mechanical enforcement of invariants |

The distinctive contribution is the use of these ideas as an **AI orchestration and context-management methodology**.

---

## 18. Proposed AI Workflow

A mature workflow could follow this sequence:

```text
Ticket or feature request
        ↓
Repository and dependency analysis
        ↓
Dependency graph generation
        ↓
Contract generation or recovery
        ↓
Contract review
        ↓
Select lowest unblocked node
        ↓
Generate implementation
        ↓
Generate and run evidence
        ↓
Accept or reject node
        ↓
Unlock direct dependants
        ↓
Run integration checkpoint
        ↓
Repeat until feature completion
```

Potential agent roles include:

### Research agent

Identifies requirements, architecture, dependencies, and uncertainties.

### Contract author

Defines inputs, outputs, guarantees, failures, invariants, and examples.

### Contract reviewer

Challenges assumptions, ambiguity, and missing edge cases.

### Implementation agent

Receives only the current contract, direct dependency contracts, and relevant source files.

### Verification agent

Produces evidence through compilation, tests, static analysis, and integration checks.

### Integration reviewer

Checks composition across accepted nodes and validates end-to-end behaviour.

---

## 19. Possible Repository Artefacts

A project adopting this method might contain:

```text
contracts/
├── domain/
├── repositories/
├── application/
├── adapters/
└── contract-index.yaml

evidence/
├── domain/
├── repositories/
├── application/
└── adapters/
```

Example contract index:

```yaml
nodes:
  - id: github_signature_verifier
    contract: contracts/adapters/github_signature_verifier.yaml
    implementation:
      - crates/github_adapter/src/signature.rs
    evidence: evidence/adapters/github_signature_verifier.yaml
    depends_on: []
    status: accepted

  - id: webhook_endpoint
    contract: contracts/http/webhook_endpoint.yaml
    implementation:
      - crates/http_api/src/github_webhook.rs
    evidence: evidence/http/webhook_endpoint.yaml
    depends_on:
      - github_signature_verifier
      - github_webhook_parser
      - task_service
    status: pending
```

---

## 20. Limitations

Dependency Driven Development does not guarantee absolute correctness.

It cannot eliminate:

- incomplete requirements
- incorrect contracts
- insufficient tests
- production-only failures
- emergent distributed-system behaviour
- subjective product-quality concerns
- human misunderstanding

Its purpose is narrower and more practical:

> Maximise confidence while minimising the reasoning surface required at each implementation step.

Correctness becomes:

- incremental
- evidence-based
- compositional
- auditable
- explicitly bounded by assumptions

rather than assumed from compilation or a single end-to-end test.

---

## 21. Conclusion

Dependency Driven Development proposes that AI-assisted software engineering should be organised around **accepted contracts and explicit evidence rather than source code alone**.

Its implementation order is dependency-driven. Its acceptance mechanism is contract-driven. Its reasoning process is discretely bounded. Its confidence model is compositional.

The most important structural distinction is between:

```text
Contract
What must be true

Implementation
The code that attempts to make it true

Evidence
Why the project currently believes it is true
```

By keeping these artefacts separate, AI-generated changes become easier to review, challenge, invalidate, and re-verify.

The methodology does not replace integration testing, human judgement, or architecture. It provides a framework for dividing large software changes into small, dependency-ordered verification problems that both humans and AI agents can reason about more reliably.

As code generation becomes cheaper, the central challenge increasingly becomes not how to produce code, but how to structure work so that generated code can be trusted.

Dependency Driven Development is one possible answer.
