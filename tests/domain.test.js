import assert from "node:assert/strict";
import test from "node:test";

import { CatalogService, ValidationFailure } from "../src/domain/catalog-service.js";
import { EventStore, ConcurrencyError } from "../src/domain/event-store.js";
import { buildSeed } from "../data/seed-story.js";

const curator = { id: "c1", name: "馆员甲", role: "curator" };
const editor = { id: "e1", name: "编目甲", role: "editor" };

function svcWithCarrier() {
  const svc = new CatalogService();
  svc.accessionCarrier({ carrier_id: "c1", title: "测试磁带", actor: curator });
  return svc;
}

test("捐赠协议、保管、批次、文件与校验值保持与同一盘磁带关联", () => {
  const svc = svcWithCarrier();
  svc.recordDonationAgreement({ agreement_id: "a1", carrier_id: "c1", donor_name: "捐赠人", actor: curator });
  svc.recordCustody({ carrier_id: "c1", keeper: "本馆", storage_location: "库位X", actor: curator });
  svc.recordDigitizationBatch({ batch_id: "b1", carrier_id: "c1", actor: curator });
  const sha = "a".repeat(64);
  svc.recordFile({ file_id: "f1", carrier_id: "c1", batch_id: "b1", role: "original_capture", sha256: sha, actor: curator });
  svc.verifyDigitization({ file_id: "f1", actual_sha256: sha, actor: curator });

  const carrier = svc.state.carriers.get("c1");
  assert.deepEqual(carrier.agreement_ids, ["a1"]);
  assert.deepEqual(carrier.batch_ids, ["b1"]);
  assert.deepEqual(carrier.file_ids, ["f1"]);
  assert.equal(carrier.custody[0].keeper, "本馆");
  assert.equal(svc.state.files.get("f1").verified, true);
  assert.equal(svc.state.batches.get("b1").file_ids[0], "f1");
});

test("校验值不一致时数字化校验不通过并留痕", () => {
  const svc = svcWithCarrier();
  svc.recordFile({ file_id: "f1", carrier_id: "c1", role: "preservation_master", sha256: "a".repeat(64), actor: curator });
  const evt = svc.verifyDigitization({ file_id: "f1", actual_sha256: "b".repeat(64), actor: curator });
  assert.equal(evt.payload.ok, false);
  assert.equal(svc.state.files.get("f1").verified, false);
  assert.equal(svc.state.files.get("f1").verify_history.length, 1);

  assert.throws(
    () => svc.verifyDigitization({ file_id: "f1", actual_sha256: "b".repeat(64), requireMatch: true, actor: curator }),
    ValidationFailure,
  );
});

test("降噪件等派生版本必须声明来源；原始采集不得被声明为派生", () => {
  const svc = svcWithCarrier();
  const sha = "a".repeat(64);
  svc.recordFile({ file_id: "m", carrier_id: "c1", role: "preservation_master", sha256: sha, actor: curator });

  assert.throws(
    () => svc.recordFile({ file_id: "d", carrier_id: "c1", role: "denoised", sha256: "b".repeat(64), actor: curator }),
    /派生版本/,
  );
  assert.throws(
    () => svc.recordFile({ file_id: "o2", carrier_id: "c1", role: "original_capture", sha256: "c".repeat(64), derived_from_file_id: "m", actor: curator }),
    /不得设置 derived_from/,
  );

  svc.recordFile({ file_id: "d", carrier_id: "c1", role: "denoised", sha256: "d".repeat(64), derived_from_file_id: "m", actor: curator });
  assert.equal(svc.state.files.get("d").derived_from_file_id, "m");
});

test("说话人候选可以并存；无法确认的身份不得强行定案", () => {
  const { service: svc, ids } = buildSeed();
  const seg = "seg-kl-03-99";
  svc.defineSegment({ segment_id: seg, carrier_id: ids.carrier, start_ms: 0, end_ms: 1000, source_file_ids: [], actor: editor });

  // 无候选直接认定 → 拒绝
  assert.throws(
    () => svc.resolveSpeaker({ segment_id: seg, person_id: ids.personLi, actor: curator }),
    /无法确认的身份不得强行定案/,
  );

  // 低置信度无据候选不得 confirmed
  svc.proposeSpeakerCandidate({ segment_id: seg, person_id: ids.personWrong, confidence: 0.1, evidence: "仅音近", actor: editor });
  assert.throws(
    () => svc.resolveSpeaker({ segment_id: seg, person_id: ids.personWrong, certainty: "confirmed", actor: curator }),
    /置信度过低/,
  );

  // 多候选并存
  svc.proposeSpeakerCandidate({ segment_id: seg, person_id: ids.personLi, confidence: 0.9, evidence: "家谱与嗓音", actor: editor });
  assert.equal(svc.state.identities.get(seg).candidates.length, 2);

  // 撤销认定回到 undetermined
  svc.resolveSpeaker({ segment_id: seg, person_id: null, reason: "证据不足", actor: curator });
  assert.equal(svc.state.identities.get(seg).status, "undetermined");
  assert.equal(svc.state.identities.get(seg).decided_person_id, null);
});

test("逐字稿校订形成版本链，旧版本保留且不允许静默覆盖", () => {
  const { service: svc, ids } = buildSeed();
  const bucket = svc.state.transcripts.get(ids.segMain);
  assert.equal(bucket.revisions.length, 2);
  assert.equal(bucket.current.revision_id, ids.revisionV2);
  assert.equal(bucket.current.supersedes_revision_id, ids.revisionV1);
  // 旧版文字仍在
  assert.match(bucket.revisions[0].text, /王长河/);
  assert.match(bucket.current.text, /李长林/);
  // changes 留痕
  assert.equal(bucket.current.changes[0].kind, "speaker_name");

  assert.throws(
    () =>
      svc.correctTranscript({
        segment_id: ids.segMain,
        revision_id: "rev-x",
        text: "直接改",
        changes: [],
        actor: curator,
      }),
    /changes/,
  );
});

test("校订意见并存，追加不覆盖", () => {
  const { service: svc, ids } = buildSeed();
  const notes = svc.state.notes.get(ids.segMain);
  assert.deepEqual(notes.map((n) => n.note_id), ["note-001", "note-002", "note-003"]);
  assert.deepEqual([...new Set(notes.map((n) => n.kind))], ["objection", "verification", "dissent"]);
});

test("开放决定必须携带各自依据；遮蔽必须给 mask；暂缓必须给理由", () => {
  const { service: svc, ids } = buildSeed();
  const seg = "seg-dec-test";
  svc.defineSegment({ segment_id: seg, carrier_id: ids.carrier, start_ms: 0, end_ms: 1000, source_file_ids: [], actor: editor });
  assert.throws(() => svc.decideRelease({ segment_id: seg, action: "open", basis: "nope", actor: curator }), /依据/);
  assert.throws(() => svc.decideRelease({ segment_id: seg, action: "masked", basis: "kin_privacy", actor: curator }), /mask/);
  assert.throws(() => svc.decideRelease({ segment_id: seg, action: "withheld", basis: "donor_restriction", actor: curator }), /reason/);
  svc.decideRelease({ segment_id: seg, action: "masked", basis: "kin_privacy", mask: { text_spans: [], audio_ranges_ms: [] }, actor: curator });
  assert.equal(svc.effectiveDecisionFor(seg).action, "masked");
});

test("事件按聚合流分配递增版本，乐观并发冲突被检出", () => {
  const store = new EventStore();
  const svc = new CatalogService(store);
  svc.accessionCarrier({ carrier_id: "c1", title: "t", actor: curator });
  // 手动制造冲突：期望版本 0，但当前已是 1
  assert.throws(
    () =>
      store.append(
        [
          {
            event_id: "dup-test-1",
            event_type: "CUSTODY_RECORDED",
            aggregate_type: "physical_carrier",
            aggregate_id: "c1",
            occurred_at: new Date().toISOString(),
            version: 0,
            summary: "x",
            payload: { carrier_id: "c1", keeper: "k" },
          },
        ],
        { expectedVersions: new Map([["physical_carrier/c1", 0]]) },
      ),
    ConcurrencyError,
  );
  // 同一 event_id 不可重放
  assert.throws(
    () =>
      store.append([
        { ...store.all()[0], version: 0 },
      ]),
    /event_id 重复/,
  );
});

test("临时下架与恢复都是新事件，事件流只追加", () => {
  const { service: svc, ids } = buildSeed();
  const types = svc.store.byAggregate("audio_segment", ids.segTakedown).map((e) => e.event_type);
  assert.deepEqual(types, ["SEGMENT_DEFINED", "SEGMENT_WITHDRAWN", "SEGMENT_RESTORED"]);
  assert.equal(svc.state.segments.get(ids.segTakedown).status, "active");
});
