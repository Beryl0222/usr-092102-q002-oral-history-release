import assert from "node:assert/strict";
import test from "node:test";

import { OralHistoryService, DomainError } from "../src/domain/commands.js";
import { EventStore } from "../src/domain/store.js";
import { reduceAll } from "../src/domain/reduce.js";
import { validateEvent, EVENT_TYPES, AGGREGATE_TYPES } from "../src/validator.js";

const cataloger = { id: "u1", role: "cataloger" };
const tech = { id: "u2", role: "digitization_tech" };
const reviewer = { id: "u3", role: "reviewer" };
const release = { id: "u4", role: "release_officer" };
const rights = { id: "u5", role: "rights_officer" };

function freshService() {
  const svc = new OralHistoryService();
  svc.accessionCarrier(cataloger, {
    carrier_id: "c1",
    title: "测试磁带",
    duration_ms: 600_000,
  }, "e-c1");
  svc.recordDigitizationBatch(tech, { batch_id: "b1", file_ids: ["f0"] }, "e-b1");
  svc.verifyDigitization(tech, {
    batch_id: "b1",
    file_id: "f0",
    carrier_id: "c1",
    channels: 2,
    checksums: [{ algorithm: "sha256", value: "abc" }],
  }, "e-f0");
  return svc;
}

test("事件枚举与契约同步", () => {
  assert.ok(EVENT_TYPES.includes("SEGMENT_WITHDRAWN"));
  assert.ok(EVENT_TYPES.includes("TRANSCRIPT_REVISED"));
  assert.ok(AGGREGATE_TYPES.includes("release_decision"));
  const sample = {
    event_id: "x", event_type: "REVIEW_NOTE_ADDED", aggregate_type: "review_note",
    aggregate_id: "r", occurred_at: "2026-10-01T00:00:00Z", version: 1, summary: "s",
  };
  assert.deepEqual(validateEvent(sample), []);
  assert.match(validateEvent({ ...sample, occurred_at: "昨天" }).join(), /ISO 8601/);
  assert.match(validateEvent({ ...sample, event_type: "NOPE" }).join(), /未知事件类型/);
});

test("event_id 全局唯一、流内版本严格递增", () => {
  const store = new EventStore();
  const svc = new OralHistoryService(store);
  svc.accessionCarrier(cataloger, { carrier_id: "c-x", title: "甲" }, "dup-id");
  assert.throws(
    () => svc.accessionCarrier(cataloger, { carrier_id: "c-y", title: "乙" }, "dup-id"),
    /禁止复用/,
  );
  svc.accessionCarrier(cataloger, { carrier_id: "c-y", title: "乙" }, "id-2");
  assert.equal(store.versionOf("physical_carrier", "c-y"), 1);
});

test("派生文件必须溯源到原始采集，禁止冒充原件", () => {
  const svc = freshService();
  assert.throws(
    () => svc.recordDerivative(tech, { file_id: "d1", source_file_id: "missing", checksums: [{ algorithm: "sha256", value: "z" }] }),
    /上游文件/,
  );
  assert.throws(
    () => svc.recordDerivative(tech, { file_id: "d1", source_file_id: "f0", kind: "original_capture", checksums: [{ algorithm: "sha256", value: "z" }] }),
    /不得冒充原始采集/,
  );
  svc.recordDerivative(tech, { file_id: "d1", source_file_id: "f0", kind: "noise_reduced", checksums: [{ algorithm: "sha256", value: "z" }] }, "e-d1");
  // 多级派生（访问代理←降噪←原始）合法
  svc.recordDerivative(tech, { file_id: "a1", source_file_id: "d1", kind: "access_proxy", checksums: [{ algorithm: "sha256", value: "y" }] }, "e-a1");
  const st = svc.state();
  assert.equal(st.files.get("d1").role, "derived");
  assert.equal(st.files.get("a1").source_file_id, "d1");
});

test("原始采集必须登记校验值", () => {
  const svc = new OralHistoryService();
  svc.accessionCarrier(cataloger, { carrier_id: "c1", title: "t" }, "e1");
  svc.recordDigitizationBatch(tech, { batch_id: "b1", file_ids: ["f0"] }, "e2");
  assert.throws(
    () => svc.verifyDigitization(tech, { batch_id: "b1", file_id: "f0", carrier_id: "c1", checksums: [] }),
    /校验值/,
  );
});

test("捐赠协议—磁带—保管—数字化批次相互关联", () => {
  const svc = freshService();
  svc.recordDonationAgreement(rights, { agreement_id: "g1", donor: "捐赠人" }, "e-g1");
  svc.linkCarrierAgreement(cataloger, { carrier_id: "c1", agreement_id: "g1" }, "e-link");
  svc.fileCustody(cataloger, { record_id: "u1", carrier_id: "c1", location_code: "B3-01" }, "e-cu");
  const st = svc.state();
  assert.deepEqual(st.carriers.get("c1").agreement_ids, ["g1"]);
  assert.equal(st.custodies.get("c1")[0].location_code, "B3-01");
  assert.equal(st.files.get("f0").batch_id, "b1");
});

test("切分时间窗不得越界，双声道文件才能按 L/R 切分", () => {
  const svc = freshService();
  assert.throws(
    () => svc.cutSegment(cataloger, { segment_id: "s1", carrier_id: "c1", source_file_id: "f0", time_range: { start_ms: 0, end_ms: 900_000 } }),
    /超出磁带时长/,
  );
  const mono = new OralHistoryService();
  mono.accessionCarrier(cataloger, { carrier_id: "m", title: "m", duration_ms: 10_000 }, "em");
  mono.recordDigitizationBatch(tech, { batch_id: "bm", file_ids: ["fm"] }, "ebm");
  mono.verifyDigitization(tech, { batch_id: "bm", file_id: "fm", carrier_id: "m", channels: 1, checksums: [{ algorithm: "md5", value: "1" }] }, "efm");
  assert.throws(
    () => mono.cutSegment(cataloger, { segment_id: "sm", carrier_id: "m", source_file_id: "fm", time_range: { start_ms: 0, end_ms: 5000 }, channel: "L" }),
    /单声道/,
  );
});

test("有争议的身份不得强行定案；确认必须附依据", () => {
  const svc = freshService();
  svc.registerPerson(cataloger, { person_id: "p1", display_name: "某甲" }, "e-p1");
  svc.cutSegment(cataloger, { segment_id: "s1", carrier_id: "c1", source_file_id: "f0", time_range: { start_ms: 0, end_ms: 60_000 } }, "e-s1");
  svc.proposeSpeakers(cataloger, "s1", [{ candidate_id: "k1", person_id: "p1", disputed: true }], "add", "e-prop");
  assert.throws(
    () => svc.confirmSpeaker(reviewer, "s1", { candidate_id: "k1", evidence: ["孤证"] }),
    /争议/,
  );
  assert.throws(
    () => svc.confirmSpeaker(reviewer, "s1", { candidate_id: "k1", dispute_resolved: true, evidence: [] }),
    /判定依据/,
  );
  svc.confirmSpeaker(reviewer, "s1", { candidate_id: "k1", dispute_resolved: true, evidence: ["捐赠协议", "登记本"] }, "e-confirm");
  const st = svc.state();
  assert.equal(st.segments.get("s1").confirmed_speaker.person_id, "p1");
  // 无候选不能凭空确认（assert.throws 抛出的 DomainError 经 assert.throws 包装时 message 不含 "Error: " 前缀）
  assert.throws(
    () => svc.confirmSpeaker(reviewer, "s1", { candidate_id: "ghost", evidence: ["x"] }),
    (err) => err instanceof DomainError && /已登记的说话人候选/.test(err.message),
  );
});

test("逐字稿校订只追加新版本；必须基于当前版本；旧版永不消失", () => {
  const svc = freshService();
  svc.cutSegment(cataloger, { segment_id: "s1", carrier_id: "c1", source_file_id: "f0", time_range: { start_ms: 0, end_ms: 60_000 } }, "e-s1");
  svc.draftTranscript(cataloger, { segment_id: "s1", text: "v1 文字" }, "e-t1");
  assert.throws(() => svc.draftTranscript(cataloger, { segment_id: "s1", text: "又一稿" }), /已有逐字稿初稿/);
  // 校订必须基于当前版本：基于 v9 的校订应被拒绝
  assert.throws(
    () => svc.reviseTranscript(reviewer, { segment_id: "s1", based_on_version: 9, text: "跳过" }),
    /基于当前版本/,
  );
  svc.reviseTranscript(reviewer, { segment_id: "s1", based_on_version: 1, change_summary: "校字", text: "v2 文字", corrections: [] }, "e-t2");
  const t = svc.state().transcripts.get("tr-s1");
  assert.equal(t.current_version, 2);
  assert.equal(t.versions[0].text, "v1 文字");
  assert.equal(t.versions[1].based_on_version, 1);
  // 事件日志重放得到同一状态
  assert.equal(reduceAll(svc.store.log).transcripts.get("tr-s1").current_version, 2);
});

test("校订意见并存，互不覆盖", () => {
  const svc = freshService();
  svc.cutSegment(cataloger, { segment_id: "s1", carrier_id: "c1", source_file_id: "f0", time_range: { start_ms: 0, end_ms: 60_000 } }, "e-s1");
  svc.addReviewNote(reviewer, { segment_id: "s1", category: "identity", note: "后代意见：应作甲" }, "n1");
  svc.addReviewNote(cataloger, { segment_id: "s1", category: "identity", note: "馆员意见：暂存疑" }, "n2");
  const notes = [...svc.state().notes.values()];
  assert.equal(notes.length, 2);
  assert.notEqual(notes[0].author, notes[1].author);
});

test("开放决定须给依据；遮蔽须说明范围；变更须针对已有决定", () => {
  const svc = freshService();
  svc.cutSegment(cataloger, { segment_id: "s1", carrier_id: "c1", source_file_id: "f0", time_range: { start_ms: 0, end_ms: 60_000 } }, "e-s1");
  assert.throws(() => svc.approveRelease(release, { segment_id: "s1", disposition: "open", bases: [] }), /至少给出一项依据/);
  assert.throws(
    () => svc.approveRelease(release, { segment_id: "s1", disposition: "masked", bases: ["family_privacy"] }),
    /遮蔽范围/,
  );
  svc.approveRelease(release, {
    segment_id: "s1", disposition: "masked", bases: ["family_privacy"],
    masking: { redact_spans: [{ start_offset: 0, end_offset: 1 }] },
  }, "e-r1");
  assert.throws(
    () => svc.approveRelease(release, { segment_id: "s1", disposition: "open", bases: ["donor_consent"] }),
    /应走变更/,
  );
  svc.amendRelease(release, { segment_id: "s1", disposition: "open", bases: ["donor_consent"] }, "e-r2");
  const d = svc.state().decisions.get("rd-s1");
  assert.equal(d.current_version, 2);
  assert.equal(d.versions[0].disposition, "masked");
});

test("临时下架不可重复；恢复后才可再次下架；不影响其他片段", () => {
  const svc = freshService();
  svc.cutSegment(cataloger, { segment_id: "s1", carrier_id: "c1", source_file_id: "f0", time_range: { start_ms: 0, end_ms: 60_000 } }, "e-s1");
  svc.cutSegment(cataloger, { segment_id: "s2", carrier_id: "c1", source_file_id: "f0", time_range: { start_ms: 60_000, end_ms: 120_000 } }, "e-s2");
  svc.withdrawSegment(release, "s1", { reason: "核实亲属异议" }, "e-w1");
  assert.throws(() => svc.withdrawSegment(release, "s1", { reason: "重复" }), /已处于下架/);
  const st = svc.state();
  assert.equal(st.segments.get("s1").withdrawals[0].restored_event, null);
  assert.equal(st.segments.get("s2").withdrawals.length, 0);
  svc.restoreSegment(release, "s1", "异议排除", "e-res");
  // 恢复是独立事件；重放状态后确认下架记录已闭环
  const st2 = svc.state();
  assert.equal(st2.segments.get("s1").withdrawals[0].restored_event, "e-res");
});

test("角色授权：编目员不能作开放决定，开放官不能登记校验", () => {
  const svc = new OralHistoryService();
  svc.accessionCarrier(cataloger, { carrier_id: "c1", title: "t" }, "e1");
  assert.throws(
    () => svc.approveRelease(cataloger, { segment_id: "x", disposition: "open", bases: ["donor_consent"] }),
    /无权/,
  );
  assert.throws(
    () => svc.verifyDigitization(release, { batch_id: "b", file_id: "f", carrier_id: "c1", checksums: [{ algorithm: "md5", value: "x" }] }),
    /无权/,
  );
});

test("原始事件摄入同样执行校验、角色与版本指派", () => {
  const svc = freshService();
  assert.throws(
    () => svc.appendRawEvent({
      event_type: "SEGMENT_CUT", aggregate_type: "audio_segment", aggregate_id: "s9",
      occurred_at: "2026-10-01T00:00:00Z", summary: "切分",
      payload: { carrier_id: "c1", source_file_id: "f0", time_range: { start_ms: 0, end_ms: 10_000 } },
      version: 99,
    }),
    /actor/,
  );
  svc.appendRawEvent({
    event_id: "raw-1", event_type: "SEGMENT_CUT", aggregate_type: "audio_segment", aggregate_id: "s9",
    occurred_at: "2026-10-01T00:00:00Z", summary: "切分", actor: cataloger,
    payload: { carrier_id: "c1", source_file_id: "f0", time_range: { start_ms: 0, end_ms: 10_000 } },
    version: 99, // 应由服务端改写为 1
  });
  assert.equal(svc.store.getEvent("raw-1").version, 1);
  assert.throws(() => svc.appendRawEvent({
    event_id: "raw-2", event_type: "UNKNOWN_TYPE", aggregate_type: "audio_segment", aggregate_id: "s10",
    occurred_at: "2026-10-01T00:00:00Z", version: 1, summary: "x", actor: cataloger, payload: {},
  }), DomainError);
});
