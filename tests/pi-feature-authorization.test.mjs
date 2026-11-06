import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

test(
  "authorization accepts supplied feature and task structures",
  {
    skip:
      !process.execArgv.includes("--experimental-test-module-mocks") &&
      "Requires --experimental-test-module-mocks to isolate approvedDesign",
  },
  async (suite) => {
    const unexpectedVerification = () =>
      assert.fail("Feature verification is outside authorization");
    suite.mock.module(
      "../pi/agent/lib/verification/feature.mjs",
      {
        namedExports: {
          approvedDesign: (_repository, feature) => feature.context,
          featureRequirements: unexpectedVerification,
          authenticateFeatureRecord: unexpectedVerification,
          planFor: unexpectedVerification,
          meaningful: unexpectedVerification,
          monitorTrackedInputs: unexpectedVerification,
          reviewScope: unexpectedVerification,
          featureObligationsVerified: unexpectedVerification,
        },
      },
    );
    const {
      approveFeatureDirection,
      featureAuthorized,
      requireFeatureAuthorization,
    } =
      await import("../pi/agent/lib/authorization/feature.mjs");

    async function fixture(context) {
      const directory = await mkdtemp(
        path.join(tmpdir(), "pi-feature-authority-"),
      );
      context.after(() => rm(directory, { recursive: true, force: true }));
      const git = (...args) =>
        execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
      git("init", "-q", "-b", "feature/authorization");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.invalid");
      git("commit", "--allow-empty", "-qm", "baseline");
      const feature = {
        id: "F",
        workflow: { kind: "recursive-issues/v1" },
        branch: "feature/authorization",
        original_baseline: git("rev-parse", "HEAD"),
        design_ref: "sha256:" + "a".repeat(64),
        context: "Approved direction",
        objective: "Preserve behavior",
        acceptance_criteria: ["Behavior works"],
        tasks: { F: {} },
      };
      return {
        args: { featureId: "F" },
        data: { feature, tasks: feature.tasks },
        context: { directory },
        git,
      };
    }

    await suite.test(
      "retains and reuses authority without scaffold state",
      async (context) => {
        const fixtureData = await fixture(context);
        const { args, data } = fixtureData;
        let confirmations = 0;
        const options = {
          confirmFeature: async () => {
            confirmations++;
            return structuredClone(data.feature);
          },
        };
        assert.equal(
          await featureAuthorized(args, data, fixtureData.context),
          false,
        );
        await assert.rejects(
          requireFeatureAuthorization(args, data, fixtureData.context),
          /Approve the overall feature direction/,
        );
        const approved = await approveFeatureDirection(
          args,
          data,
          fixtureData.context,
          options,
        );
        assert.equal(approved.ok, true, approved.message);
        assert.equal(
          await featureAuthorized(args, data, fixtureData.context),
          true,
        );
        await requireFeatureAuthorization(args, data, fixtureData.context);
        const reused = await approveFeatureDirection(
          args,
          data,
          fixtureData.context,
          options,
        );
        assert.equal(reused.recovered, true);
        assert.equal(reused.reference, approved.reference);
        assert.equal(confirmations, 1);
        assert.equal(
          await featureAuthorized(
            { featureId: "other" },
            data,
            fixtureData.context,
          ),
          false,
        );
      },
    );

    await suite.test(
      "clean and reinitialize requires new approval even for identical ticket, design and Git baseline",
      async (context) => {
        const local = await fixture(context);
        const { args, data, context: runtime } = local;
        const originallyInitialized = "1".repeat(32);
        data.feature.workflow.instance_id = originallyInitialized;
        let confirmations = 0;
        const options = {
          confirmFeature: async () => {
            confirmations++;
            return structuredClone(data.feature);
          },
        };
        const old = await approveFeatureDirection(args, data, runtime, options);
        assert.equal(old.ok, true, old.message);
        assert.equal(old.scope.instanceId, originallyInitialized);
        assert.equal(await featureAuthorized(args, data, runtime), true);

        // A new Scaffold init produces a different instance ID even if the
        // Linear ticket, design, branch and original baseline are unchanged.
        data.feature.workflow.instance_id = "2".repeat(32);
        assert.equal(await featureAuthorized(args, data, runtime), false);
        await assert.rejects(
          requireFeatureAuthorization(args, data, runtime),
          /Approve the overall feature direction/,
        );

        const recreated = await approveFeatureDirection(args, data, runtime, options);
        assert.equal(recreated.ok, true, recreated.message);
        assert.equal(recreated.recovered, undefined);
        assert.notEqual(recreated.reference, old.reference);
        assert.equal(recreated.scope.instanceId, "2".repeat(32));
        assert.equal(confirmations, 2);
      },
    );

    await suite.test(
      "checks fresh feature direction after confirmation",
      async (context) => {
        const { args, data, context: runtime } = await fixture(context);
        const result = await approveFeatureDirection(args, data, runtime, {
          confirmFeature: async () => ({
            ...data.feature,
            objective: "Changed direction",
          }),
        });
        assert.equal(result.ok, false);
        assert.match(
          result.message,
          /Feature direction changed during approval/,
        );
        assert.equal(await featureAuthorized(args, data, runtime), false);
      },
    );

    await suite.test(
      "rejects branch changes during confirmation",
      async (context) => {
        const { args, data, context: runtime, git } = await fixture(context);
        const result = await approveFeatureDirection(args, data, runtime, {
          confirmFeature: async () => {
            git("switch", "-qc", "feature/other");
            return data.feature;
          },
        });
        assert.equal(result.ok, false);
        assert.match(result.message, /Feature branch mismatch/);
      },
    );

    await suite.test(
      "explains why a feature initialized on main cannot be authorized",
      async (context) => {
        const { args, data, context: runtime, git } = await fixture(context);
        git("branch", "-m", "main");
        data.feature.branch = "main";
        const denied = await approveFeatureDirection(args, data, runtime, {
          confirmFeature: async () => assert.fail("Must not confirm on a protected branch"),
        });
        assert.equal(denied.ok, false);
        assert.match(denied.message, /protected branch 'main'/);
        assert.match(denied.message, /switching Git branches alone/);
        await assert.rejects(
          requireFeatureAuthorization(args, data, runtime),
          /protected branch 'main'/,
        );
        assert.equal(await featureAuthorized(args, data, runtime), false);
      },
    );

    await suite.test(
      "rejects the remote default branch even when it is not named main",
      async (context) => {
        const { args, data, context: runtime, git } = await fixture(context);
        git("branch", "-m", "release");
        git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
        data.feature.branch = "release";
        const result = await approveFeatureDirection(args, data, runtime, {
          confirmFeature: async () => assert.fail("Must not confirm on default branch"),
        });
        assert.equal(result.ok, false);
        assert.match(result.message, /protected branch 'release'/);
      },
    );

    await suite.test(
      "reports each invalid feature or task binding instead of a generic mismatch",
      async (context) => {
        const cases = [
          {
            name: "missing recorded branch",
            mutate: ({ data }) => { data.feature.branch = ""; },
            expected: /no feature branch recorded/,
          },
          {
            name: "unsupported workflow",
            mutate: ({ data }) => { data.feature.workflow.kind = "unrecognized"; },
            expected: /unsupported issue workflow/,
          },
          {
            name: "missing baseline",
            mutate: ({ data }) => { data.feature.original_baseline = ""; },
            expected: /original Git baseline is missing/,
          },
          {
            name: "unknown task",
            mutate: ({ data, args }) => {
              args.task = { featureId: "F", taskId: "unknown", designRef: data.feature.design_ref };
            },
            expected: /does not exist in Scaffold feature F/,
          },
          {
            name: "incorrect task feature",
            mutate: ({ data, args }) => {
              args.task = { featureId: "different", taskId: "F", designRef: data.feature.design_ref };
            },
            expected: /Task feature ID mismatch/,
          },
          {
            name: "incorrect branch argument",
            mutate: ({ args }) => { args.branch = "feature/elsewhere"; },
            expected: /Feature branch argument mismatch/,
          },
          {
            name: "incorrect baseline argument",
            mutate: ({ args }) => { args.featureBaseRef = "f".repeat(40); },
            expected: /Original feature baseline mismatch/,
          },
        ];
        for (const testCase of cases) {
          const local = await fixture(context);
          testCase.mutate(local);
          const result = await approveFeatureDirection(
            local.args, local.data, local.context,
            { confirmFeature: async () => assert.fail("Must fail before approval: " + testCase.name) },
          );
          assert.equal(result.ok, false, testCase.name);
          assert.match(result.message, testCase.expected, testCase.name);
          assert.doesNotMatch(result.message, /Feature authority scope mismatch/);
        }
      },
    );

    await suite.test(
      "requires recoverable supplied task history",
      async (context) => {
        const { args, data, context: runtime } = await fixture(context);
        for (const tasks of [
          undefined,
          { F: { delivery: { head: "previous-attempt" } } },
        ]) {
          const inputs = { ...data, tasks };
          await assert.rejects(
            requireFeatureAuthorization(args, inputs, runtime),
            /EVIDENCE_RECOVERY_REQUIRED/,
          );
          const result = await approveFeatureDirection(args, inputs, runtime, {
            confirmFeature: async () =>
              assert.fail("Must not confirm missing historical authority"),
          });
          assert.equal(result.ok, false);
          assert.match(result.message, /EVIDENCE_RECOVERY_REQUIRED/);
        }
      },
    );

    await suite.test(
      "denial and cancellation never retain authority",
      async (context) => {
        const { args, data, context: runtime } = await fixture(context);
        const denied = await approveFeatureDirection(args, data, runtime, {
          confirmFeature: async () => false,
        });
        assert.equal(denied.ok, false);
        const controller = new AbortController();
        const cancelled = await approveFeatureDirection(
          args,
          data,
          { ...runtime, abort: controller.signal },
          {
            confirmFeature: async () => {
              controller.abort();
              return data.feature;
            },
          },
        );
        assert.equal(cancelled.ok, false);
        assert.equal(await featureAuthorized(args, data, runtime), false);
      },
    );
  },
);
