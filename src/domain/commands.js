// 命令层：把馆员操作翻译成只追加事件，并在此执行业务不变量。
// 关键纪律：
//  - 校订只能追加新版本，旧逐字稿事件永不修改（研究引用不失出处）；
//  - 说话人只能先成为候选，确认必须有依据，仍有争议且未解决的身份不得定案；
//  - 降噪件等派生文件必须溯源到原始采集；
//  - 下架/恢复作用于单个片段流，磁带与其他片段不受影响。

import { validateEvent } from "../validator.js";
import { reduceAll } from "./reduce.js";
import { EventStore } from "./store.js";
import { decisionId, transcriptStreamId } from "./identifiers.js";

export class DomainError extends Error {}

const AGG = {
  CARRIER_ACCESSIONED: "physical_carrier",
  DONATION_AGREEMENT_RECORDED: "donation_agreement",
  CARRIER_AGREEMENT_LINKED: "physical_carrier",
  CUSTODY_RECORD_FILED: "custody_record",
  DIGITIZATION_BATCH_RECORDED: "digitization_batch",
  DIGITIZATION_VERIFIED: "digitization_batch",
  DERIVATIVE_RECORDED: "audio_file",
  PERSON_REGISTERED: "person",
  PERSON_ALIAS_NOTED: "person",
  SEGMENT_CUT: "audio_segment",
  SPEAKERS_PROPOSED: "audio_segment",
  SPEAKER_CONFIRMED: "audio_segment",
  TRANSCRIPT_DRAFTED: "transcript_revision",
  TRANSCRIPT_REVISED: "transcript_revision",
  REVIEW_NOTE_ADDED: "review_note",
  SONG_RIGHTS_ASSESSED: "song_rights",
  RELEASE_APPROVED: "release_decision",
  RELEASE_DECISION_AMENDED: "release_decision",
  SEGMENT_WITHDRAWN: "audio_segment",
  SEGMENT_RESTORED: "audio_segment",
};

export const ROLES = {
  cataloger: "cataloger",
  digitization_tech: "digitization_tech",
  reviewer: "reviewer",
  rights_officer: "rights_officer",
  release_officer: "release_officer",
  admin: "admin",
};

const ROLE_ALLOW = {
  CARRIER_ACCESSIONED: ["cataloger", "admin"],
  DONATION_AGREEMENT_RECORDED: ["rights_officer", "admin"],
  CARRIER_AGREEMENT_LINKED: ["cataloger", "rights_officer", "admin"],
  CUSTODY_RECORD_FILED: ["cataloger", "admin"],
  DIGITIZATION_BATCH_RECORDED: ["digitization_tech", "admin"],
  DIGITIZATION_VERIFIED: ["digitization_tech", "admin"],
  DERIVATIVE_RECORDED: ["digitization_tech", "admin"],
  PERSON_REGISTERED: ["cataloger", "reviewer", "admin"],
  PERSON_ALIAS_NOTED: ["cataloger", "reviewer", "admin"],
  SEGMENT_CUT: ["cataloger", "digitization_tech", "admin"],
  SPEAKERS_PROPOSED: ["cataloger", "reviewer", "admin"],
  SPEAKER_CONFIRMED: ["reviewer", "rights_officer", "admin"],
  TRANSCRIPT_DRAFTED: ["cataloger", "reviewer", "admin"],
  TRANSCRIPT_REVISED: ["reviewer", "cataloger", "admin"],
  REVIEW_NOTE_ADDED: ["reviewer", "cataloger", "rights_officer", "admin"],
  SONG_RIGHTS_ASSESSED: ["rights_officer", "admin"],
  RELEASE_APPROVED: ["release_officer", "admin"],
  RELEASE_DECISION_AMENDED: ["release_officer", "admin"],
  SEGMENT_WITHDRAWN: ["release_officer", "rights_officer", "admin"],
  SEGMENT_RESTORED: ["release_officer", "admin"],
};

export const DISPOSITIONS = ["open", "masked", "withheld"];
export const DECISION_BASES = [
  "donor_consent", // 捐赠人同意开放（正向依据）
  "memorial_sensitivity", // 纪念敏感期
  "family_privacy", // 亲属隐私（含背景第三人的家事）
  "donation_restriction", // 捐赠限制
  "song_rights", // 歌曲权利
  "identity_uncertainty", // 身份尚未确认
  "security_of_carrier", // 载体/原始库位安全
];

function assert(cond, message) {
  if (!cond) throw new DomainError(message);
}

function emit(store, state, { type, aggregateId, actor, payload, summary, eventId, causationId, at }) {
  assert(actor && typeof actor.id === "string" && typeof actor.role === "string", "事件必须记录 actor");
  const roles = ROLE_ALLOW[type] ?? [];
  assert(roles.includes(actor.role), `角色 ${actor.role} 无权记录 ${type}`);
  const aggregateType = AGG[type];
  const version = store.versionOf(aggregateType, aggregateId) + 1;
  const event = {
    event_id: eventId ?? `${aggregateId}-evt-${version}`,
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: at ?? new Date().toISOString(),
    version,
    summary,
    actor: { id: actor.id, role: actor.role, ...(actor.name ? { name: actor.name } : {}) },
    ...(causationId ? { causation_id: causationId } : {}),
    payload,
  };
  const envelopeErrors = validateEvent(event);
  assert(envelopeErrors.length === 0, envelopeErrors.join("；"));
  // 业务不变量（需要当前状态时在此抛出）
  guard(type, event, state);
  return store.append(event);
}

function nonEmptyString(v, label) {
  assert(typeof v === "string" && v.trim().length > 0, `${label}不能为空`);
}

function validTimeRange(range, carrier) {
  assert(range && Number.isFinite(range.start_ms) && Number.isFinite(range.end_ms), "时间片段必须给出起止毫秒");
  assert(range.start_ms >= 0, "片段起点不能为负");
  assert(range.end_ms > range.start_ms, "片段止点必须晚于起点");
  if (carrier?.duration_ms != null) {
    assert(range.end_ms <= carrier.duration_ms, "片段超出磁带时长");
  }
}

function guard(type, e, s) {
  const p = e.payload ?? {};
  switch (type) {
    case "CARRIER_AGREEMENT_LINKED": {
      assert(s.carriers.has(e.aggregate_id), `磁带不存在：${e.aggregate_id}`);
      assert(s.agreements.has(p.agreement_id), `捐赠协议不存在：${p.agreement_id}`);
      break;
    }
    case "CUSTODY_RECORD_FILED":
      assert(s.carriers.has(p.carrier_id), `保管记录所指磁带不存在：${p.carrier_id}`);
      break;
    case "DIGITIZATION_BATCH_RECORDED":
      assert(Array.isArray(p.file_ids) && p.file_ids.length > 0, "数字化批次必须包含文件");
      break;
    case "DIGITIZATION_VERIFIED": {
      assert(s.carriers.has(p.carrier_id), `数字化所指磁带不存在：${p.carrier_id}`);
      assert(s.batches.has(e.aggregate_id), `校验事件必须挂在已有批次流上：${e.aggregate_id}`);
      assert(Array.isArray(p.checksums) && p.checksums.length > 0, "原始采集必须登记至少一个校验值");
      for (const c of p.checksums) {
        nonEmptyString(c.algorithm, "校验算法");
        nonEmptyString(c.value, "校验值");
      }
      break;
    }
    case "DERIVATIVE_RECORDED": {
      const src = s.files.get(p.source_file_id);
      assert(src, `派生文件必须指向上游文件：${p.source_file_id}`);
      assert(p.kind !== "original_capture", "派生文件不得冒充原始采集");
      // 沿溯源链最终必须到达原始采集
      let cur = src;
      const seen = new Set();
      while (cur && cur.role === "derived" && !seen.has(cur.file_id)) {
        seen.add(cur.file_id);
        cur = s.files.get(cur.source_file_id);
      }
      assert(cur && cur.role === "original_capture", "派生链路必须溯源到原始采集文件");
      assert(Array.isArray(p.checksums) && p.checksums.length > 0, "派生文件必须登记校验值");
      break;
    }
    case "PERSON_ALIAS_NOTED":
      assert(s.persons.has(e.aggregate_id), `人物不存在：${e.aggregate_id}`);
      nonEmptyString(p.alias, "旧称/别名");
      break;
    case "SEGMENT_CUT": {
      const carrier = s.carriers.get(p.carrier_id);
      assert(carrier, `片段所指磁带不存在：${p.carrier_id}`);
      const src = s.files.get(p.source_file_id);
      assert(src, `片段所指音频文件不存在：${p.source_file_id}`);
      validTimeRange(p.time_range, carrier);
      if (p.channel === "L" || p.channel === "R") {
        assert((src.channels ?? 2) >= 2, "单声道文件无法按左右声道切分");
      }
      break;
    }
    case "SPEAKERS_PROPOSED": {
      const seg = s.segments.get(e.aggregate_id);
      assert(seg, `片段不存在：${e.aggregate_id}`);
      for (const c of p.candidates ?? []) {
        if (p.action === "withdraw") {
          nonEmptyString(c.candidate_id, "候选标识");
        } else {
          nonEmptyString(c.candidate_id, "候选标识");
          assert(c.person_id || c.proposed_name, "候选必须指向已登记人物或给出待查称呼");
        }
      }
      break;
    }
    case "SPEAKER_CONFIRMED": {
      const seg = s.segments.get(e.aggregate_id);
      assert(seg, `片段不存在：${e.aggregate_id}`);
      const cand = seg.speaker_candidates.find((x) => x.candidate_id === p.candidate_id);
      assert(cand, `只能确认已登记的说话人候选：${p.candidate_id}`);
      assert(cand.status !== "withdrawn", "该候选已撤回，不能据此定案");
      assert(cand.status !== "confirmed" || p.force_reconfirm === true, "该候选已经确认");
      if (cand.disputed && p.dispute_resolved !== true) {
        throw new DomainError("候选身份仍有争议且未给出解决依据，不得强行定案");
      }
      assert(Array.isArray(p.evidence) && p.evidence.length > 0, "确认说话人必须附判定依据");
      break;
    }
    case "TRANSCRIPT_DRAFTED":
    case "TRANSCRIPT_REVISED": {
      const seg = s.segments.get(p.segment_id);
      assert(seg, `逐字稿所指片段不存在：${p.segment_id}`);
      nonEmptyString(p.text, "逐字稿文本");
      const exists = s.transcripts.get(e.aggregate_id);
      if (type === "TRANSCRIPT_DRAFTED") {
        assert(!exists, `该片段已有逐字稿初稿：${p.segment_id}`);
      } else {
        assert(exists, "尚无初稿，无法校订");
        assert(
          p.based_on_version === exists.current_version,
          `校订必须基于当前版本 v${exists.current_version}`,
        );
      }
      break;
    }
    case "REVIEW_NOTE_ADDED":
      assert(s.segments.has(p.segment_id), `校订意见所指片段不存在：${p.segment_id}`);
      nonEmptyString(p.note, "校订意见内容");
      break;
    case "SONG_RIGHTS_ASSESSED": {
      nonEmptyString(p.title, "歌曲名称");
      assert(["public_domain", "licensed", "unresolved"].includes(p.work_status), "歌曲著作权状态取值非法");
      for (const id of p.segment_ids ?? []) assert(s.segments.has(id), `歌曲所指片段不存在：${id}`);
      break;
    }
    case "RELEASE_APPROVED":
    case "RELEASE_DECISION_AMENDED": {
      assert(s.segments.has(p.segment_id), `开放决定所指片段不存在：${p.segment_id}`);
      assert(DISPOSITIONS.includes(p.disposition), `开放处置取值非法：${p.disposition}`);
      assert(Array.isArray(p.bases) && p.bases.length > 0, "开放决定必须至少给出一项依据");
      for (const b of p.bases) assert(DECISION_BASES.includes(b), `未知开放依据：${b}`);
      const existing = s.decisions.get(e.aggregate_id);
      if (type === "RELEASE_APPROVED") assert(!existing, "该片段已作开放决定，应走变更");
      if (type === "RELEASE_DECISION_AMENDED") assert(existing, "该片段尚无开放决定，不能变更");
      if (p.disposition !== "open") {
        assert(
          p.bases.some((b) => b !== "identity_uncertainty") || p.disposition === "withheld",
          "遮蔽/暂缓须指明限制依据",
        );
      }
      if (p.disposition === "masked") {
        assert(p.masking && typeof p.masking === "object", "遮蔽处置必须说明遮蔽范围");
      }
      break;
    }
    case "SEGMENT_WITHDRAWN": {
      const seg = s.segments.get(e.aggregate_id);
      assert(seg, `下架所指片段不存在：${e.aggregate_id}`);
      nonEmptyString(p.reason, "下架理由");
      const openWithdrawal = seg.withdrawals.find((w) => w.restored_event === null);
      assert(!openWithdrawal, "该片段已处于下架状态，不能重复下架");
      break;
    }
    case "SEGMENT_RESTORED": {
      const seg = s.segments.get(e.aggregate_id);
      assert(seg, `恢复所指片段不存在：${e.aggregate_id}`);
      const openWithdrawal = seg.withdrawals.find((w) => w.restored_event === null);
      assert(openWithdrawal, "该片段未处于下架状态");
      break;
    }
    default:
      break;
  }
}

/**
 * 应用服务：持有事件存储，每次命令从日志重放状态。
 * 数据量在单馆编目尺度下足够；需要扩容时可换成快照而不改变命令接口。
 */
export class OralHistoryService {
  /** @param {EventStore} [store] */
  constructor(store = new EventStore()) {
    this.store = store;
  }

  state() {
    return reduceAll(this.store.log);
  }

  /**
   * 摄入已成形事件（批量导入/API 通用入口）。
   * 不跳过任何检查：信封、角色授权、业务不变量与版本连续性照常生效。
   */
  appendRawEvent(event, expectedVersion) {
    assert(event && typeof event === "object", "事件必须是对象");
    assert(event.actor, "事件必须记录 actor");
    const roles = ROLE_ALLOW[event.event_type] ?? [];
    assert(roles.includes(event.actor.role), `角色 ${event.actor.role} 无权记录 ${event.event_type}`);
    // version 是服务端维护的流内序号，以事件存储为准（防止导入端伪造或漏填）
    const nextVersion = this.store.versionOf(event.aggregate_type, event.aggregate_id) + 1;
    const normalized = { ...event, version: nextVersion };
    const errors = validateEvent(normalized);
    assert(errors.length === 0, errors.join("；"));
    guard(normalized.event_type, normalized, this.state());
    return this.store.append(normalized, expectedVersion);
  }

  #do(opts) {
    return emit(this.store, this.state(), opts);
  }

  accessionCarrier(actor, input, eventId) {
    nonEmptyString(input.carrier_id, "磁带标识");
    return this.#do({
      type: "CARRIER_ACCESSIONED",
      aggregateId: input.carrier_id,
      actor,
      eventId,
      summary: `入藏磁带：${input.title ?? input.carrier_id}`,
      payload: {
        title: input.title ?? null,
        tape_no: input.tape_no ?? null,
        media_type: input.media_type ?? null,
        duration_ms: input.duration_ms ?? null,
        recorded_on: input.recorded_on ?? null,
        original_location: input.original_location ?? null,
      },
    });
  }

  recordDonationAgreement(actor, input, eventId) {
    nonEmptyString(input.agreement_id, "捐赠协议标识");
    nonEmptyString(input.donor, "捐赠人");
    return this.#do({
      type: "DONATION_AGREEMENT_RECORDED",
      aggregateId: input.agreement_id,
      actor,
      eventId,
      summary: `登记捐赠协议：${input.agreement_no ?? input.agreement_id}`,
      payload: {
        agreement_no: input.agreement_no ?? null,
        donor: input.donor,
        signed_on: input.signed_on ?? null,
        scope_carrier_id: input.scope_carrier_id ?? null,
        scope_segment_ids: input.scope_segment_ids ?? [],
        restrictions: input.restrictions ?? [],
      },
    });
  }

  linkCarrierAgreement(actor, { carrier_id, agreement_id }, eventId) {
    return this.#do({
      type: "CARRIER_AGREEMENT_LINKED",
      aggregateId: carrier_id,
      actor,
      eventId,
      summary: `磁带 ${carrier_id} 关联捐赠协议 ${agreement_id}`,
      payload: { agreement_id },
    });
  }

  fileCustody(actor, input, eventId) {
    nonEmptyString(input.record_id, "保管记录标识");
    return this.#do({
      type: "CUSTODY_RECORD_FILED",
      aggregateId: input.record_id,
      actor,
      eventId,
      summary: `载体保管记录：${input.carrier_id} @ ${input.location_code ?? "?"}`,
      payload: {
        carrier_id: input.carrier_id,
        location_code: input.location_code ?? null,
        transferred_from: input.transferred_from ?? null,
        received_on: input.received_on ?? null,
        condition: input.condition ?? null,
        handler: input.handler ?? null,
      },
    });
  }

  recordDigitizationBatch(actor, input, eventId) {
    nonEmptyString(input.batch_id, "批次标识");
    return this.#do({
      type: "DIGITIZATION_BATCH_RECORDED",
      aggregateId: input.batch_id,
      actor,
      eventId,
      summary: `数字化批次：${input.batch_no ?? input.batch_id}`,
      payload: {
        batch_no: input.batch_no ?? null,
        digitized_on: input.digitized_on ?? null,
        operator: input.operator ?? actor.id,
        equipment: input.equipment ?? null,
        file_ids: input.file_ids ?? [],
      },
    });
  }

  verifyDigitization(actor, input, eventId) {
    return this.#do({
      type: "DIGITIZATION_VERIFIED",
      aggregateId: input.batch_id,
      actor,
      eventId,
      summary: `原始采集校验通过：${input.file_id}`,
      payload: {
        file_id: input.file_id,
        carrier_id: input.carrier_id,
        batch_id: input.batch_id,
        codec: input.codec ?? null,
        sample_rate: input.sample_rate ?? null,
        channels: input.channels ?? null,
        byte_size: input.byte_size ?? null,
        checksums: input.checksums ?? [],
      },
    });
  }

  recordDerivative(actor, input, eventId) {
    nonEmptyString(input.file_id, "派生文件标识");
    return this.#do({
      type: "DERIVATIVE_RECORDED",
      aggregateId: input.file_id,
      actor,
      eventId,
      summary: `派生文件（${input.kind ?? "processed"}）：${input.file_id} ← ${input.source_file_id}`,
      payload: {
        source_file_id: input.source_file_id,
        kind: input.kind ?? "processed",
        process: input.process ?? null,
        carrier_id: input.carrier_id ?? null,
        codec: input.codec ?? null,
        byte_size: input.byte_size ?? null,
        checksums: input.checksums ?? [],
      },
    });
  }

  registerPerson(actor, input, eventId) {
    nonEmptyString(input.person_id, "人物标识");
    nonEmptyString(input.display_name, "人物姓名");
    return this.#do({
      type: "PERSON_REGISTERED",
      aggregateId: input.person_id,
      actor,
      eventId,
      summary: `登记人物：${input.display_name}`,
      payload: {
        display_name: input.display_name,
        visibility: input.visibility ?? "public",
        note: input.note ?? null,
        roles: input.roles ?? [],
      },
    });
  }

  notePersonAlias(actor, input, eventId) {
    return this.#do({
      type: "PERSON_ALIAS_NOTED",
      aggregateId: input.person_id,
      actor,
      eventId,
      summary: `记录旧称/别名：${input.alias} → ${input.person_id}`,
      payload: { alias: input.alias, period: input.period ?? null, note: input.note ?? null },
    });
  }

  cutSegment(actor, input, eventId) {
    nonEmptyString(input.segment_id, "片段标识");
    return this.#do({
      type: "SEGMENT_CUT",
      aggregateId: input.segment_id,
      actor,
      eventId,
      summary: `声道/时间切分：${input.segment_id}`,
      payload: {
        carrier_id: input.carrier_id,
        source_file_id: input.source_file_id,
        time_range: input.time_range,
        channel: input.channel ?? "mixed",
        topics: input.topics ?? [],
        people_mentioned: input.people_mentioned ?? [],
        song_ids: input.song_ids ?? [],
      },
    });
  }

  proposeSpeakers(actor, segmentId, candidates, action = "add", eventId) {
    return this.#do({
      type: "SPEAKERS_PROPOSED",
      aggregateId: segmentId,
      actor,
      eventId,
      summary:
        action === "withdraw"
          ? `撤回说话人候选：${segmentId}`
          : `提出说话人候选：${segmentId}`,
      payload: { action, candidates },
    });
  }

  confirmSpeaker(actor, segmentId, input, eventId) {
    return this.#do({
      type: "SPEAKER_CONFIRMED",
      aggregateId: segmentId,
      actor,
      eventId,
      summary: `确认说话人：${segmentId} ← 候选 ${input.candidate_id}`,
      payload: {
        candidate_id: input.candidate_id,
        person_id: input.person_id ?? null,
        evidence: input.evidence ?? [],
        note: input.note ?? null,
        dispute_resolved: input.dispute_resolved ?? false,
        force_reconfirm: input.force_reconfirm ?? false,
      },
    });
  }

  draftTranscript(actor, input, eventId) {
    return this.#do({
      type: "TRANSCRIPT_DRAFTED",
      aggregateId: transcriptStreamId(input.segment_id),
      actor,
      eventId,
      summary: `逐字稿初稿：${input.segment_id}`,
      payload: {
        segment_id: input.segment_id,
        text: input.text,
        corrections: input.corrections ?? [],
      },
    });
  }

  reviseTranscript(actor, input, eventId) {
    const s = this.state();
    const streamId = transcriptStreamId(input.segment_id);
    const current = s.transcripts.get(streamId);
    return this.#do({
      type: "TRANSCRIPT_REVISED",
      aggregateId: streamId,
      actor,
      eventId,
      summary: `逐字稿校订 v${(current?.current_version ?? 0) + 1}：${input.segment_id}（${input.change_summary ?? "未注明"}）`,
      payload: {
        segment_id: input.segment_id,
        text: input.text,
        based_on_version: input.based_on_version ?? current?.current_version,
        change_summary: input.change_summary ?? null,
        corrections: input.corrections ?? [],
      },
    });
  }

  addReviewNote(actor, input, eventId) {
    const s = this.state();
    const count = [...s.notes.values()].filter((n) => n.segment_id === input.segment_id).length;
    const noteId = input.note_id ?? `rn-${input.segment_id}-${String(count + 1).padStart(3, "0")}`;
    return this.#do({
      type: "REVIEW_NOTE_ADDED",
      aggregateId: noteId,
      actor,
      eventId,
      summary: `校订意见：${input.segment_id}（${input.category ?? "general"}）`,
      payload: {
        segment_id: input.segment_id,
        category: input.category ?? "general",
        note: input.note,
        transcript_version: input.transcript_version ?? null,
        resolution: input.resolution ?? null,
      },
    });
  }

  assessSongRights(actor, input, eventId) {
    nonEmptyString(input.song_id, "歌曲标识");
    return this.#do({
      type: "SONG_RIGHTS_ASSESSED",
      aggregateId: input.song_id,
      actor,
      eventId,
      summary: `歌曲权利评估：${input.title}（${input.work_status}）`,
      payload: {
        title: input.title,
        work_status: input.work_status,
        license: input.license ?? null,
        rights_holders_note: input.rights_holders_note ?? null,
        segment_ids: input.segment_ids ?? [],
        basis: input.basis ?? null,
      },
    });
  }

  approveRelease(actor, input, eventId) {
    return this.#do({
      type: "RELEASE_APPROVED",
      aggregateId: decisionId(input.segment_id),
      actor,
      eventId,
      summary: `开放决定：${input.segment_id} → ${input.disposition}`,
      payload: {
        segment_id: input.segment_id,
        disposition: input.disposition,
        bases: input.bases ?? [],
        masking: input.masking ?? null,
        rationale: input.rationale ?? null,
        review_after: input.review_after ?? null,
      },
    });
  }

  amendRelease(actor, input, eventId) {
    return this.#do({
      type: "RELEASE_DECISION_AMENDED",
      aggregateId: decisionId(input.segment_id),
      actor,
      eventId,
      summary: `开放决定变更：${input.segment_id} → ${input.disposition}`,
      payload: {
        segment_id: input.segment_id,
        disposition: input.disposition,
        bases: input.bases ?? [],
        masking: input.masking ?? null,
        rationale: input.rationale ?? null,
        review_after: input.review_after ?? null,
      },
    });
  }

  withdrawSegment(actor, segmentId, input = {}, eventId) {
    return this.#do({
      type: "SEGMENT_WITHDRAWN",
      aggregateId: segmentId,
      actor,
      eventId,
      summary: `临时下架片段：${segmentId}（${input.reason ?? "未说明"}）`,
      payload: {
        reason: input.reason ?? "",
        basis_refs: input.basis_refs ?? [],
        expected_restore_after: input.expected_restore_after ?? null,
      },
    });
  }

  restoreSegment(actor, segmentId, note = "", eventId) {
    return this.#do({
      type: "SEGMENT_RESTORED",
      aggregateId: segmentId,
      actor,
      eventId,
      summary: `恢复片段：${segmentId}${note ? `（${note}）` : ""}`,
      payload: { note },
    });
  }
}
