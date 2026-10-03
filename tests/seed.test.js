import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { OralHistoryService } from "../src/domain/commands.js";
import { buildScenario } from "../src/scenario.js";
import { validateEvent } from "../src/validator.js";

// 种子文件是"只经事件"重建系统的证明：新库实例仅靠摄入这些 JSON 事件，
// 必须得到与命令构建完全一致的状态。
test("种子事件文件可独立回放并复现场景状态", async () => {
  const raw = JSON.parse(await readFile(new URL("../data/scenario-events.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(raw) && raw.length > 30);
  for (const e of raw) assert.deepEqual(validateEvent(e), []);

  const rebuilt = new OralHistoryService();
  for (const e of raw) rebuilt.appendRawEvent(e);

  const canonical = buildScenario().state();
  const got = rebuilt.state();
  assert.equal(got.segments.size, canonical.segments.size);
  assert.equal(got.carriers.size, canonical.carriers.size);
  assert.equal(got.files.size, canonical.files.size);
  assert.equal(got.decisions.size, canonical.decisions.size);
  assert.equal(got.notes.size, canonical.notes.size);

  // 逐字稿修订链与稳定事件标识完整保留
  const west = got.transcripts.get("tr-seg-07-02");
  assert.equal(west.current_version, 2);
  assert.equal(west.versions[0].event_id, "evt-tr-02-v1");
  assert.match(west.versions[0].text, /李衡/);
  assert.match(west.versions[1].text, /李恒山/);

  // 事件标识无重复
  const ids = rebuilt.store.log.map((e) => e.event_id);
  assert.equal(new Set(ids).size, ids.length);
});
