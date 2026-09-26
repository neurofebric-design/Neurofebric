import test from "node:test";
import assert from "node:assert/strict";

import { EMPTY_POLICY_LIMITS, parsePolicyConfig } from "./policy-config.ts";

const SOURCE = "test:neurofebric-policy.json";

function baseLimits() {
  return { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 };
}

function parse(raw: unknown) {
  return parsePolicyConfig({ version: 1, ...raw }, SOURCE);
}

test("an active profile merges over the base limits field by field", () => {
  const config = parse({
    limits: baseLimits(),
    limitProfiles: { gauntlet: { maxFileWritesPerTask: 50 } },
    activeLimitProfile: "gauntlet",
  });
  assert.equal(config.limits.maxFileWritesPerTask, 50);
  assert.equal(config.limits.maxToolCallsPerTask, 40);
  assert.equal(config.limits.maxBytesPerWrite, 2_000_000);
  assert.equal(config.activeLimitProfile, "gauntlet");
});

test("without an active profile the base limits stand and profiles are inert", () => {
  const config = parse({ limits: baseLimits(), limitProfiles: { gauntlet: { maxFileWritesPerTask: 50 } } });
  assert.equal(config.limits.maxFileWritesPerTask, 10);
  assert.equal(config.activeLimitProfile, undefined);
});

test("a profile may tighten as well as raise, and may override any subset", () => {
  const config = parse({
    limits: baseLimits(),
    limitProfiles: { locked: { maxFileWritesPerTask: 3, maxBytesPerWrite: 64 } },
    activeLimitProfile: "locked",
  });
  assert.equal(config.limits.maxFileWritesPerTask, 3);
  assert.equal(config.limits.maxBytesPerWrite, 64);
  assert.equal(config.limits.maxToolCallsPerTask, 40);
});

test("with several profiles defined only the active one applies", () => {
  const config = parse({
    limits: baseLimits(),
    limitProfiles: { gauntlet: { maxFileWritesPerTask: 50 }, locked: { maxFileWritesPerTask: 3 } },
    activeLimitProfile: "gauntlet",
  });
  assert.equal(config.limits.maxFileWritesPerTask, 50);
});

test("an unknown active profile fails at load, not at first denial", () => {
  assert.throws(
    () => parse({ limitProfiles: { gauntlet: { maxFileWritesPerTask: 50 } }, activeLimitProfile: "gauntel" }),
    /gauntel/,
  );
});

test("an active profile with no limitProfiles defined at all fails at load", () => {
  assert.throws(() => parse({ activeLimitProfile: "gauntlet" }), /activeLimitProfile/);
});

test("invalid profile values fail with the profile-scoped field name", () => {
  for (const bad of [0, -1, 1.5, "50"]) {
    assert.throws(
      () => parse({ limitProfiles: { gauntlet: { maxFileWritesPerTask: bad } }, activeLimitProfile: "gauntlet" }),
      (error: Error) =>
        /limitProfiles\.gauntlet\.maxFileWritesPerTask/.test(error.message)
        && /positive integer/.test(error.message),
    );
  }
});

test("a typo'd key inside a profile fails loudly instead of silently doing nothing", () => {
  assert.throws(() => parse({ limitProfiles: { gauntlet: { maxFileWritePerTask: 50 } } }), /is not a known limit/);
});

test("profile names and the active selection must be kebab-case", () => {
  assert.throws(() => parse({ limitProfiles: { Gauntlet: { maxFileWritesPerTask: 50 } } }), /kebab-case/);
  assert.throws(
    () => parse({ limitProfiles: { gauntlet: { maxFileWritesPerTask: 50 } }, activeLimitProfile: "Gauntlet" }),
    /kebab-case/,
  );
});

test("every profile error names the source file", () => {
  assert.throws(
    () => parsePolicyConfig({ activeLimitProfile: "missing" }, SOURCE),
    (error: Error) => error.message.includes(SOURCE),
  );
});

test("unconfigured fallback limits are untouched by the profile machinery", () => {
  const config = parse({});
  assert.deepEqual(config.limits, EMPTY_POLICY_LIMITS);
  assert.deepEqual(config.limitProfiles, {});
});
