/**
 * 领域事件工厂：统一事件信封，并集中声明事件 → 聚合的归属。
 *
 * 每个命令产生的事件 version 是该聚合流上的序号（从 1 开始），
 * 由 EventStore 在追加时分配，保证乐观并发与稳定的版本解释。
 */
import { randomUUID } from "node:crypto";

export const EVENT_TYPES = Object.freeze({
  CARRIER_ACCESSIONED: "CARRIER_ACCESSIONED",
  DONATION_AGREEMENT_RECORDED: "DONATION_AGREEMENT_RECORDED",
  CUSTODY_RECORDED: "CUSTODY_RECORDED",
  DIGITIZATION_BATCH_RECORDED: "DIGITIZATION_BATCH_RECORDED",
  MASTER_FILE_RECORDED: "MASTER_FILE_RECORDED",
  DIGITIZATION_VERIFIED: "DIGITIZATION_VERIFIED",
  SEGMENT_DEFINED: "SEGMENT_DEFINED",
  PERSON_RECORDED: "PERSON_RECORDED",
  SPEAKER_ANNOTATED: "SPEAKER_ANNOTATED",
  SPEAKER_CANDIDATE_PROPOSED: "SPEAKER_CANDIDATE_PROPOSED",
  SPEAKER_CANDIDATE_RESOLVED: "SPEAKER_CANDIDATE_RESOLVED",
  TRANSCRIPT_RECORDED: "TRANSCRIPT_RECORDED",
  TRANSCRIPT_CORRECTED: "TRANSCRIPT_CORRECTED",
  REVIEW_NOTE_ADDED: "REVIEW_NOTE_ADDED",
  SONG_RIGHTS_RECORDED: "SONG_RIGHTS_RECORDED",
  RELEASE_DECIDED: "RELEASE_DECIDED",
  RELEASE_APPROVED: "RELEASE_APPROVED",
  SEGMENT_WITHDRAWN: "SEGMENT_WITHDRAWN",
  SEGMENT_RESTORED: "SEGMENT_RESTORED",
});

/** 事件归属的聚合类型（aggregate_type 必须与之一致）。 */
export const EVENT_AGGREGATE = Object.freeze({
  CARRIER_ACCESSIONED: "physical_carrier",
  DONATION_AGREEMENT_RECORDED: "donation_agreement",
  CUSTODY_RECORDED: "physical_carrier",
  DIGITIZATION_BATCH_RECORDED: "digitization_batch",
  MASTER_FILE_RECORDED: "media_file",
  DIGITIZATION_VERIFIED: "media_file",
  SEGMENT_DEFINED: "audio_segment",
  PERSON_RECORDED: "person",
  SPEAKER_ANNOTATED: "speaker_identity",
  SPEAKER_CANDIDATE_PROPOSED: "speaker_identity",
  SPEAKER_CANDIDATE_RESOLVED: "speaker_identity",
  TRANSCRIPT_RECORDED: "transcript_revision",
  TRANSCRIPT_CORRECTED: "transcript_revision",
  REVIEW_NOTE_ADDED: "review_note",
  SONG_RIGHTS_RECORDED: "song_rights",
  RELEASE_DECIDED: "release_decision",
  RELEASE_APPROVED: "release_decision",
  SEGMENT_WITHDRAWN: "audio_segment",
  SEGMENT_RESTORED: "audio_segment",
});

let seq = 0;
export function newEventId(prefix = "evt") {
  seq += 1;
  return `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${process.pid}-${seq}-${randomUUID().slice(0, 8)}`;
}

/**
 * 构造一条领域事件。
 * @param {string} eventType
 * @param {string} aggregateId
 * @param {object} payload
 * @param {{actor?: object, occurredAt?: string, eventId?: string}} [meta]
 */
export function makeEvent(eventType, aggregateId, payload = {}, meta = {}) {
  const aggregateType = EVENT_AGGREGATE[eventType];
  if (!aggregateType) throw new Error(`未知事件类型：${eventType}`);
  return {
    event_id: meta.eventId ?? newEventId(eventType.toLowerCase()),
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: meta.occurredAt ?? new Date().toISOString(),
    version: 0, // 由 EventStore 追加时填写为聚合流版本
    actor: meta.actor ?? null,
    summary: payload.summary ?? "",
    payload,
  };
}
