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
