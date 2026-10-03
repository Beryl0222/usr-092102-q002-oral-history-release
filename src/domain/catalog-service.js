/**
 * CatalogService：口述录音开放编目应用服务。
 *
 * 所有写操作都产出事件并交给 EventStore；当前状态由 Projection 重放得到。
 * 关键不变量集中在本层：
 *  - 降噪件/访问件只能是派生版本，必须有 derived_from；原始采集不得被声明为派生；
 *  - 数字化校验通过以 sha256 一致为准；
 *  - 说话人可以并存多个候选；无法确认的身份不得强行定案（确认必须基于已登记候选与证据）；
 *  - 逐字稿修正形成版本链，旧版本保留，稳定引用不失效；
 *  - 校订意见只追加、并存；
 *  - 开放/遮蔽/暂缓必须各自携带依据；
 *  - 临时下架只作用于片段及其衍生文件闭包。
 */
import { EventStore } from "./event-store.js";
import { EVENT_TYPES, makeEvent } from "./events.js";
import {
  applyEvent,
  createEmptyState,
  derivedFilesForSegment,
  effectiveDecision,
  fold,
} from "./projection.js";

export class ValidationFailure extends Error {
  constructor(errors) {
    super(Array.isArray(errors) ? errors.join("；") : errors);
    this.name = "ValidationFailure";
    this.errors = Array.isArray(errors) ? errors : [errors];
  }
}

const DERIVED_ROLES = new Set(["denoised", "access"]);

export class CatalogService {
  constructor(eventStore = new EventStore()) {
    this.store = eventStore;
    this.state = fold(this.store.all());
  }

  // ---------- 内部 ----------

  _commit(events) {
    const expected = new Map();
    for (const e of events) {
      expected.set(EventStore.streamKey(e), this.store.streamVersions.get(EventStore.streamKey(e)) ?? 0);
    }
    const committed = this.store.append(events, { expectedVersions: expected });
    for (const e of committed) applyEvent(this.state, e);
    return committed;
  }

  _one(event) {
    return this._commit([event])[0];
  }

  _requireCarrier(carrierId) {
    const c = this.state.carriers.get(carrierId);
    if (!c) throw new ValidationFailure(`载体不存在：${carrierId}`);
    return c;
  }

  _requireSegment(segmentId) {
    const s = this.state.segments.get(segmentId);
    if (!s) throw new ValidationFailure(`音频片段不存在：${segmentId}`);
    return s;
  }

  // ---------- 载体 / 协议 / 保管 ----------

  accessionCarrier(cmd) {
    if (!cmd.carrier_id) throw new ValidationFailure("carrier_id 必填");
    if (this.state.carriers.has(cmd.carrier_id)) throw new ValidationFailure("载体已入藏");
    if (!cmd.sha256_note && !cmd.title) throw new ValidationFailure("title 必填");
    return this._one(
      makeEvent(
        EVENT_TYPES.CARRIER_ACCESSIONED,
        cmd.carrier_id,
        {
          carrier_id: cmd.carrier_id,
          title: cmd.title,
          medium: cmd.medium ?? null,
          storage_location: cmd.storage_location ?? null,
          accessioned_at: cmd.accessioned_at ?? null,
          summary: cmd.summary ?? `载体入藏：${cmd.title}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  recordDonationAgreement(cmd) {
    this._requireCarrier(cmd.carrier_id);
    if (!cmd.agreement_id) throw new ValidationFailure("agreement_id 必填");
    if (this.state.agreements.has(cmd.agreement_id)) throw new ValidationFailure("捐赠协议已存在");
    // 协议常先于声道切分签署，applies_segment_ids 允许前向引用，不再此处校验片段存在
    return this._one(
      makeEvent(
        EVENT_TYPES.DONATION_AGREEMENT_RECORDED,
        cmd.agreement_id,
        {
          agreement_id: cmd.agreement_id,
          carrier_id: cmd.carrier_id,
          donor_name: cmd.donor_name,
          donor_contact: cmd.donor_contact ?? null,
          signed_at: cmd.signed_at ?? null,
          access_grant: cmd.access_grant ?? null,
          restrictions: cmd.restrictions ?? [],
          applies_segment_ids: cmd.applies_segment_ids ?? [],
          summary: cmd.summary ?? `登记捐赠协议：${cmd.agreement_id}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  recordCustody(cmd) {
    this._requireCarrier(cmd.carrier_id);
    return this._one(
      makeEvent(
        EVENT_TYPES.CUSTODY_RECORDED,
        cmd.carrier_id,
        {
          carrier_id: cmd.carrier_id,
          keeper: cmd.keeper,
          storage_location: cmd.storage_location ?? null,
          change_type: cmd.change_type ?? "transfer",
          note: cmd.note ?? null,
          summary: cmd.summary ?? `载体保管变更：${cmd.keeper}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  // ---------- 数字化批次 / 文件 / 校验 ----------

  recordDigitizationBatch(cmd) {
    this._requireCarrier(cmd.carrier_id);
    if (!cmd.batch_id) throw new ValidationFailure("batch_id 必填");
    if (this.state.batches.has(cmd.batch_id)) throw new ValidationFailure("数字化批次已存在");
    return this._one(
      makeEvent(
        EVENT_TYPES.DIGITIZATION_BATCH_RECORDED,
        cmd.batch_id,
        {
          batch_id: cmd.batch_id,
          carrier_id: cmd.carrier_id,
          operator: cmd.operator ?? null,
          equipment: cmd.equipment ?? null,
          started_at: cmd.started_at ?? null,
          summary: cmd.summary ?? `登记数字化批次：${cmd.batch_id}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  recordFile(cmd) {
    this._requireCarrier(cmd.carrier_id);
    if (cmd.batch_id) {
      const batch = this.state.batches.get(cmd.batch_id);
      if (!batch || batch.carrier_id !== cmd.carrier_id) {
        throw new ValidationFailure(`批次不属于该载体：${cmd.batch_id}`);
      }
    }
    if (!cmd.file_id) throw new ValidationFailure("file_id 必填");
    if (this.state.files.has(cmd.file_id)) throw new ValidationFailure("文件已登记");
    if (!cmd.sha256 || !/^[a-f0-9]{64}$/i.test(cmd.sha256)) {
      throw new ValidationFailure("sha256 必须是 64 位十六进制校验值");
    }
    if (!["original_capture", "preservation_master", "denoised", "access"].includes(cmd.role)) {
      throw new ValidationFailure("文件角色非法");
    }
    // 谱系不变量：派生版本必须能追溯到来源；原始采集不得反过来“派生自”某物
    if (DERIVED_ROLES.has(cmd.role) && !cmd.derived_from_file_id) {
      throw new ValidationFailure(`${cmd.role} 是派生版本，必须提供 derived_from_file_id`);
    }
    if (!DERIVED_ROLES.has(cmd.role) && cmd.derived_from_file_id) {
      throw new ValidationFailure(`${cmd.role} 不是派生版本，不得设置 derived_from_file_id`);
    }
    if (cmd.derived_from_file_id) {
      const parent = this.state.files.get(cmd.derived_from_file_id);
      if (!parent) throw new ValidationFailure("派生来源文件不存在");
      if (parent.carrier_id !== cmd.carrier_id) {
        throw new ValidationFailure("派生文件不得跨载体");
      }
    }
    if (cmd.segment_id) {
      const seg = this._requireSegment(cmd.segment_id);
      if (seg.carrier_id !== cmd.carrier_id) throw new ValidationFailure("片段与文件不属于同一载体");
    }
    return this._one(
      makeEvent(
        EVENT_TYPES.MASTER_FILE_RECORDED,
        cmd.file_id,
        {
          file_id: cmd.file_id,
          carrier_id: cmd.carrier_id,
          batch_id: cmd.batch_id ?? null,
          role: cmd.role,
          filename: cmd.filename ?? null,
          sha256: cmd.sha256.toLowerCase(),
          derived_from_file_id: cmd.derived_from_file_id ?? null,
          segment_id: cmd.segment_id ?? null,
          channels: cmd.channels ?? null,
          duration_ms: cmd.duration_ms ?? null,
          mime: cmd.mime ?? null,
          summary: cmd.summary ?? `登记文件：${cmd.file_id}（${cmd.role}）`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  verifyDigitization(cmd) {
    const file = this.state.files.get(cmd.file_id);
    if (!file) throw new ValidationFailure("文件不存在");
    if (!cmd.actual_sha256) throw new ValidationFailure("actual_sha256 必填");
    const ok = cmd.actual_sha256.toLowerCase() === file.sha256.toLowerCase();
    if (!ok && cmd.requireMatch) {
      throw new ValidationFailure("校验值不一致，数字化文件未通过校验");
    }
    return this._one(
      makeEvent(
        EVENT_TYPES.DIGITIZATION_VERIFIED,
        cmd.file_id,
        {
          file_id: cmd.file_id,
          expected_sha256: file.sha256,
          actual_sha256: cmd.actual_sha256.toLowerCase(),
          ok,
          verifier: cmd.verifier ?? null,
          summary: ok ? `校验通过：${cmd.file_id}` : `校验值不一致：${cmd.file_id}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  // ---------- 片段（声道切分） ----------

  defineSegment(cmd) {
    this._requireCarrier(cmd.carrier_id);
    if (!cmd.segment_id) throw new ValidationFailure("segment_id 必填");
    if (this.state.segments.has(cmd.segment_id)) throw new ValidationFailure("片段已存在");
    if (!Number.isFinite(cmd.start_ms) || !Number.isFinite(cmd.end_ms) || cmd.end_ms <= cmd.start_ms) {
      throw new ValidationFailure("时间区间非法（需要 start_ms < end_ms）");
    }
    for (const fid of cmd.source_file_ids ?? []) {
      const f = this.state.files.get(fid);
      if (!f) throw new ValidationFailure(`来源文件不存在：${fid}`);
    }
    if (cmd.parent_segment_id && !this.state.segments.has(cmd.parent_segment_id)) {
      throw new ValidationFailure("父片段不存在");
    }
    return this._one(
      makeEvent(
        EVENT_TYPES.SEGMENT_DEFINED,
        cmd.segment_id,
        {
          segment_id: cmd.segment_id,
          carrier_id: cmd.carrier_id,
          label: cmd.label ?? null,
          channel: cmd.channel ?? "mono",
          start_ms: cmd.start_ms,
          end_ms: cmd.end_ms,
          source_file_ids: [...new Set(cmd.source_file_ids ?? [])],
          parent_segment_id: cmd.parent_segment_id ?? null,
          subjects: cmd.subjects ?? [],
          language: cmd.language ?? null,
          recorded_period: cmd.recorded_period ?? null,
          recorded_at: cmd.recorded_at ?? null,
          summary: cmd.summary ?? `声道切分片段：${cmd.label ?? cmd.segment_id}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  // ---------- 人物 / 说话人 ----------

  recordPerson(cmd) {
    if (!cmd.person_id) throw new ValidationFailure("person_id 必填");
    if (this.state.persons.has(cmd.person_id)) throw new ValidationFailure("人物已登记");
    if (!cmd.display_name) throw new ValidationFailure("display_name 必填");
    return this._one(
      makeEvent(
        EVENT_TYPES.PERSON_RECORDED,
        cmd.person_id,
        {
          person_id: cmd.person_id,
          display_name: cmd.display_name,
          names: cmd.names ?? [{ value: cmd.display_name, type: "primary" }],
          born: cmd.born ?? null,
          died: cmd.died ?? null,
          public: cmd.public ?? false,
          is_kin: cmd.is_kin ?? false,
          description_public: cmd.description_public ?? null,
          summary: cmd.summary ?? `登记人物：${cmd.display_name}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  proposeSpeakerCandidate(cmd) {
    this._requireSegment(cmd.segment_id);
    const person = this.state.persons.get(cmd.person_id);
    if (!person) throw new ValidationFailure("候选人物不存在");
    if (!cmd.evidence && !(cmd.confidence > 0)) {
      throw new ValidationFailure("候选必须附带证据或置信度，无法确认的身份不得强行定案");
    }
    const identityId = cmd.identity_id ?? `id-${cmd.segment_id}`;
    return this._one(
      makeEvent(
        EVENT_TYPES.SPEAKER_CANDIDATE_PROPOSED,
        identityId,
        {
          identity_id: identityId,
          segment_id: cmd.segment_id,
          candidate: {
            person_id: cmd.person_id,
            confidence: cmd.confidence ?? null,
            evidence: cmd.evidence ?? null,
          },
          note: cmd.note ?? null,
          summary: cmd.summary ?? `提出说话人候选：${person.display_name}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  /** 兼容既有 SPEAKER_ANNOTATED 事件的写入路径（作为一次带证据的标注）。 */
  annotateSpeaker(cmd) {
    this._requireSegment(cmd.segment_id);
    if (cmd.person_id && !this.state.persons.has(cmd.person_id)) {
      throw new ValidationFailure("标注人物不存在");
    }
    const identityId = cmd.identity_id ?? `id-${cmd.segment_id}`;
    return this._one(
      makeEvent(
        EVENT_TYPES.SPEAKER_ANNOTATED,
        identityId,
        {
          identity_id: identityId,
          segment_id: cmd.segment_id,
          person_id: cmd.person_id ?? null,
          confidence: cmd.confidence ?? null,
          evidence: cmd.evidence ?? null,
          note: cmd.note ?? null,
          summary: cmd.summary ?? "说话人标注",
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  /**
   * 认定说话人。不变量：person_id 必须是已登记且有证据的候选；
   * 想撤销错误认定时传 person_id=null，回到 undetermined，而不是换成无据之人。
   */
  resolveSpeaker(cmd) {
    this._requireSegment(cmd.segment_id);
    const identity = this.state.identities.get(cmd.segment_id);
    const identityId = cmd.identity_id ?? identity?.identity_id ?? `id-${cmd.segment_id}`;

    let target = null;
    if (cmd.person_id !== null && cmd.person_id !== undefined) {
      target = (identity?.candidates ?? []).find(
        (c) => c.person_id === cmd.person_id && c.evidence,
      );
      if (!target) {
        throw new ValidationFailure(
          "认定必须基于带证据的已登记候选；无法确认的身份不得强行定案",
        );
      }
      if (cmd.certainty === "confirmed" && (target.confidence ?? 1) < 0.5) {
        throw new ValidationFailure("证据置信度过低，不能作 confirmed 认定，可保留候选或记为 probable");
      }
    }
    return this._one(
      makeEvent(
        EVENT_TYPES.SPEAKER_CANDIDATE_RESOLVED,
        identityId,
        {
          identity_id: identityId,
          segment_id: cmd.segment_id,
          person_id: cmd.person_id ?? null,
          certainty: cmd.certainty ?? "confirmed",
          reason: cmd.reason ?? null,
          resolved_by: cmd.resolved_by ?? null,
          summary:
            cmd.person_id == null
              ? `撤销说话人认定（片段 ${cmd.segment_id}）`
              : `认定说话人（片段 ${cmd.segment_id}）：${cmd.person_id}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  // ---------- 逐字稿 / 校订意见 ----------

  recordTranscript(cmd) {
    this._requireSegment(cmd.segment_id);
    if (this.state.transcripts.has(cmd.segment_id)) {
      throw new ValidationFailure("初录逐字稿已存在，请使用 correctTranscript 修正");
    }
    if (!cmd.revision_id) throw new ValidationFailure("revision_id 必填");
    if (typeof cmd.text !== "string" || !cmd.text.trim()) throw new ValidationFailure("text 必填");
    return this._one(
      makeEvent(
        EVENT_TYPES.TRANSCRIPT_RECORDED,
        cmd.revision_id,
        {
          revision_id: cmd.revision_id,
          segment_id: cmd.segment_id,
          text: cmd.text,
          mentions: cmd.mentions ?? [],
          editor: cmd.editor ?? null,
          note: cmd.note ?? null,
          summary: cmd.summary ?? `逐字稿初录：${cmd.revision_id}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  /**
   * 修正逐字稿。旧版本原样保留并形成版本链；
   * changes 说明每个修订点（例如姓名误录的纠正），使既有引用可解释差异。
   */
  correctTranscript(cmd) {
    this._requireSegment(cmd.segment_id);
    const bucket = this.state.transcripts.get(cmd.segment_id);
    if (!bucket) throw new ValidationFailure("缺少初录逐字稿");
    if (!cmd.revision_id) throw new ValidationFailure("revision_id 必填");
    if (bucket.revisions.some((r) => r.revision_id === cmd.revision_id)) {
      throw new ValidationFailure("revision_id 已存在");
    }
    if (typeof cmd.text !== "string" || !cmd.text.trim()) throw new ValidationFailure("text 必填");
    if (!Array.isArray(cmd.changes) || cmd.changes.length === 0) {
      throw new ValidationFailure("修正必须给出 changes（修订点说明），不得静默覆盖旧稿");
    }
    for (const ch of cmd.changes) {
      if (!ch.kind || !ch.reason) throw new ValidationFailure("每个修订点需要 kind 与 reason");
    }
    const prior = bucket.current;
    return this._one(
      makeEvent(
        EVENT_TYPES.TRANSCRIPT_CORRECTED,
        cmd.revision_id,
        {
          revision_id: cmd.revision_id,
          segment_id: cmd.segment_id,
          text: cmd.text,
          mentions: cmd.mentions ?? prior.mentions,
          editor: cmd.editor ?? null,
          changes: cmd.changes,
          supersedes_revision_id: cmd.supersedes_revision_id ?? prior.revision_id,
          note: cmd.note ?? null,
          summary: cmd.summary ?? `逐字稿校订：${cmd.revision_id}（接替 ${prior.revision_id}）`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  addReviewNote(cmd) {
    this._requireSegment(cmd.segment_id);
    if (!cmd.note_id) throw new ValidationFailure("note_id 必填");
    if (!cmd.body?.trim()) throw new ValidationFailure("意见正文必填");
    return this._one(
      makeEvent(
        EVENT_TYPES.REVIEW_NOTE_ADDED,
        cmd.note_id,
        {
          note_id: cmd.note_id,
          segment_id: cmd.segment_id,
          author: cmd.author ?? null,
          note_kind: cmd.note_kind ?? "general",
          body: cmd.body,
          summary: cmd.summary ?? `校订意见：${cmd.note_id}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  // ---------- 歌曲权利 ----------

  recordSongRights(cmd) {
    this._requireSegment(cmd.segment_id);
    if (!cmd.rights_id) throw new ValidationFailure("rights_id 必填");
    if (!["cleared", "pending", "denied"].includes(cmd.status)) {
      throw new ValidationFailure("权利状态必须是 cleared | pending | denied");
    }
    return this._one(
      makeEvent(
        EVENT_TYPES.SONG_RIGHTS_RECORDED,
        cmd.rights_id,
        {
          rights_id: cmd.rights_id,
          segment_id: cmd.segment_id,
          song_title: cmd.song_title,
          rights_holder: cmd.rights_holder ?? null,
          status: cmd.status,
          license: cmd.license ?? null,
          valid_from: cmd.valid_from ?? null,
          valid_to: cmd.valid_to ?? null,
          note: cmd.note ?? null,
          summary: cmd.summary ?? `歌曲权利登记：${cmd.song_title}（${cmd.status}）`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  // ---------- 开放决定 / 临时下架 / 恢复 ----------

  decideRelease(cmd) {
    this._requireSegment(cmd.segment_id);
    if (!["open", "masked", "withheld"].includes(cmd.action)) {
      throw new ValidationFailure("action 必须是 open | masked | withheld");
    }
    if (!["memorial_sensitivity", "kin_privacy", "donor_restriction", "rights_clearance", "public_interest"].includes(cmd.basis)) {
      throw new ValidationFailure("开放决定必须携带合法依据 basis");
    }
    if (cmd.action === "masked" && !cmd.mask) {
      throw new ValidationFailure("遮蔽开放必须给出 mask（文字区间与/或音频区间）");
    }
    if (cmd.action === "withheld" && !cmd.reason) {
      throw new ValidationFailure("暂缓必须写明 reason");
    }
    const decisionId = cmd.decision_id ?? `dec-${cmd.segment_id}-${(this.state.decisions.get(cmd.segment_id)?.length ?? 0) + 1}`;
    return this._one(
      makeEvent(
        EVENT_TYPES.RELEASE_DECIDED,
        decisionId,
        {
          decision_id: decisionId,
          segment_id: cmd.segment_id,
          action: cmd.action,
          basis: cmd.basis,
          reason: cmd.reason ?? null,
          decided_by: cmd.decided_by ?? null,
          valid_from: cmd.valid_from ?? null,
          valid_until: cmd.valid_until ?? null,
          mask: cmd.mask ?? null,
          summary: cmd.summary ?? `开放决定：${cmd.action}（${cmd.basis}）`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  /** 兼容既有 RELEASE_APPROVED：按 action=open / basis=public_interest 落一条决定。 */
  approveRelease(cmd) {
    this._requireSegment(cmd.segment_id);
    const decisionId = cmd.decision_id ?? `dec-${cmd.segment_id}-${(this.state.decisions.get(cmd.segment_id)?.length ?? 0) + 1}`;
    return this._one(
      makeEvent(
        EVENT_TYPES.RELEASE_APPROVED,
        decisionId,
        {
          decision_id: decisionId,
          segment_id: cmd.segment_id,
          basis: cmd.basis ?? "public_interest",
          reason: cmd.reason ?? null,
          decided_by: cmd.decided_by ?? null,
          valid_from: cmd.valid_from ?? null,
          valid_until: cmd.valid_until ?? null,
          summary: cmd.summary ?? "公开批准",
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  withdrawSegment(cmd) {
    this._requireSegment(cmd.segment_id);
    if (!cmd.reason) throw new ValidationFailure("临时下架必须写明 reason");
    return this._one(
      makeEvent(
        EVENT_TYPES.SEGMENT_WITHDRAWN,
        cmd.segment_id,
        {
          segment_id: cmd.segment_id,
          reason: cmd.reason,
          basis: cmd.basis ?? null,
          until: cmd.until ?? null,
          scope_derivatives: cmd.scope_derivatives !== false,
          withdrawn_by: cmd.withdrawn_by ?? null,
          summary: cmd.summary ?? `片段临时下架：${cmd.segment_id}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  restoreSegment(cmd) {
    this._requireSegment(cmd.segment_id);
    return this._one(
      makeEvent(
        EVENT_TYPES.SEGMENT_RESTORED,
        cmd.segment_id,
        {
          segment_id: cmd.segment_id,
          reason: cmd.reason ?? null,
          summary: cmd.summary ?? `片段恢复开放：${cmd.segment_id}`,
        },
        { actor: cmd.actor, occurredAt: cmd.occurred_at },
      ),
    );
  }

  // ---------- 读侧辅助 ----------

  snapshot() {
    return this.state;
  }

  effectiveDecisionFor(segmentId, now) {
    return effectiveDecision(this.state, segmentId, now);
  }

  derivedFilesFor(segmentId) {
    return derivedFilesForSegment(this.state, segmentId);
  }
}
