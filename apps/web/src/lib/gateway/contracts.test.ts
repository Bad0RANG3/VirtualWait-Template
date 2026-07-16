import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  gatewayCreateJobResponseSchema,
  gatewayVerificationResponseSchema,
} from "./contracts";

const fixtures = path.resolve(process.cwd(), "../../packages/contracts/fixtures");

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtures, name), "utf8"));
}

test("Web Zod boundary accepts all Gateway v1 fixtures", async () => {
  assert.equal(
    gatewayCreateJobResponseSchema.parse(
      await fixture("verification-job-create-response.v1.json")
    ).jobId,
    "d98250f2-2580-4b30-930f-095ad48b2823"
  );

  for (const name of [
    "verification-job-succeeded.v1.json",
    "verification-job-processing.v1.json",
    "verification-job-failed.v1.json",
  ]) {
    assert.ok(gatewayVerificationResponseSchema.safeParse(await fixture(name)).success, name);
  }
});

test("Web Zod boundary rejects malformed successful Gateway results", () => {
  assert.equal(
    gatewayVerificationResponseSchema.safeParse({ status: "SUCCEEDED" }).success,
    false
  );
});
