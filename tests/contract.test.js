import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent, validateEventAgainstContract } from "../src/validator.js";

test("样例符合领域约定（轻量校验）", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("样例通过契约枚举校验，且初始五事件/四聚合标识保持不变", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(await validateEventAgainstContract(sample), []);

  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  for (const t of [
    "CARRIER_ACCESSIONED",
    "DIGITIZATION_VERIFIED",
    "SPEAKER_ANNOTATED",
    "RELEASE_APPROVED",
    "SEGMENT_WITHDRAWN",
  ]) {
    assert.ok(schema.properties.event_type.enum.includes(t), `初始事件标识不得移除：${t}`);
  }
  for (const a of ["physical_carrier", "audio_segment", "transcript_revision", "release_decision"]) {
    assert.ok(schema.properties.aggregate_type.enum.includes(a), `初始聚合标识不得移除：${a}`);
  }
});

test("未登记的事件/聚合类型与非法枚举被拒绝", async () => {
  const base = {
    event_id: "x-1",
    event_type: "NOT_A_THING",
    aggregate_type: "audio_segment",
    aggregate_id: "seg-1",
    occurred_at: "2026-10-01T00:00:00Z",
    version: 1,
    summary: "x",
  };
  const errs = await validateEventAgainstContract(base);
  assert.ok(errs.some((e) => e.includes("event_type")));

  const errs2 = await validateEventAgainstContract({
    ...base,
    event_type: "RELEASE_DECIDED",
    payload: { action: "nope", basis: "made_up" },
  });
  assert.ok(errs2.some((e) => e.includes("payload.action")));
  assert.ok(errs2.some((e) => e.includes("payload.basis")));
});
