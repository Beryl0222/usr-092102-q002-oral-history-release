/**
 * Projection：把只追加的事件流归约为当前编目读模型。
 *
 * 归约是纯增量过程：任何“修正/下架/恢复”都体现为新事件叠加后的状态，
 * 历史事件与历史版本不被删除——稳定引用据此解释版本变化。
 */
import { EVENT_TYPES } from "./events.js";

const STATUS = Object.freeze({
  ACTIVE: "active",
  WITHDRAWN: "withdrawn",
});

export function createEmptyState() {
  return {
    seq: 0,
    carriers: new Map(),
    agreements: new Map(),
    batches: new Map(),
    files: new Map(),
    segments: new Map(),
    persons: new Map(),
    /** segment_id -> speaker_identity 读模型 */
    identities: new Map(),
    /** segment_id -> { current, revisions:[] } */
    transcripts: new Map(),
    /** segment_id -> review_note[]（校订意见并存，从不覆盖） */
    notes: new Map(),
    /** segment_id -> song_rights[]（按事件顺序，当前项取最后一条同歌曲） */
    songRights: new Map(),
    /** segment_id -> release_decision[]（历史全保留，当前取最后有效项） */
    decisions: new Map(),
    /** segment_id -> 当前临时下架记录（RESTORED 或过期后置空） */
    withdrawals: new Map(),
    /** 全局事件时间线（版本解释用） */
    timeline: [],
  };
}

function ensure(map, key, factory) {
  if (!map.has(key)) map.set(key, factory());
  return map.get(key);
}

/**
 * 增量应用一条事件（就地变更 state；重建时从空状态开始 fold）。
 */
export function applyEvent(state, event) {
  state.seq += 1;
  const p = event.payload ?? {};
  const at = event.occurred_at;
  const indexed = { ...event, _seq: state.seq };
  state.timeline.push(indexed);

  switch (event.event_type) {
    case EVENT_TYPES.CARRIER_ACCESSIONED: {
      state.carriers.set(p.carrier_id, {
        carrier_id: p.carrier_id,
        title: p.title,
        medium: p.medium ?? null,
        accessioned_at: p.accessioned_at ?? at,
        // 原始库位属于内部信息，仅投影、默认不向授权边界外输出
        storage_location: p.storage_location ?? null,
        agreement_ids: [],
        custody: [],
        batch_ids: [],
        file_ids: [],
        segment_ids: [],
      });
      break;
    }

    case EVENT_TYPES.DONATION_AGREEMENT_RECORDED: {
      const carrier = state.carriers.get(p.carrier_id);
      state.agreements.set(p.agreement_id, {
        agreement_id: p.agreement_id,
        carrier_id: p.carrier_id,
        donor_name: p.donor_name,
        donor_contact: p.donor_contact ?? null,
        signed_at: p.signed_at ?? at,
        access_grant: p.access_grant ?? null,
        restrictions: (p.restrictions ?? []).map((r) => ({ ...r })),
        applies_segment_ids: p.applies_segment_ids ?? [],
      });
      carrier?.agreement_ids.push(p.agreement_id);
      break;
    }

    case EVENT_TYPES.CUSTODY_RECORDED: {
      const carrier = state.carriers.get(p.carrier_id);
      if (!carrier) break;
      carrier.custody.push({
        keeper: p.keeper,
        storage_location: p.storage_location ?? null,
        change_type: p.change_type ?? "transfer",
        note: p.note ?? null,
        at,
      });
      if (p.storage_location) carrier.storage_location = p.storage_location;
      break;
    }

    case EVENT_TYPES.DIGITIZATION_BATCH_RECORDED: {
      const carrier = state.carriers.get(p.carrier_id);
      state.batches.set(p.batch_id, {
        batch_id: p.batch_id,
        carrier_id: p.carrier_id,
        operator: p.operator ?? null,
        equipment: p.equipment ?? null,
        started_at: p.started_at ?? at,
        file_ids: [],
      });
      carrier?.batch_ids.push(p.batch_id);
      break;
    }

    case EVENT_TYPES.MASTER_FILE_RECORDED: {
      const carrier = state.carriers.get(p.carrier_id);
      const batch = p.batch_id ? state.batches.get(p.batch_id) : null;
      state.files.set(p.file_id, {
        file_id: p.file_id,
        carrier_id: p.carrier_id,
        batch_id: p.batch_id ?? null,
        // original_capture | preservation_master | denoised | access
        role: p.role,
        filename: p.filename ?? null,
        sha256: p.sha256,
        // 派生谱系：降噪件/访问件必须指向来源文件
        derived_from_file_id: p.derived_from_file_id ?? null,
        segment_id: p.segment_id ?? null,
        channels: p.channels ?? null,
        duration_ms: p.duration_ms ?? null,
        mime: p.mime ?? null,
        recorded_at: at,
        verified: false,
        verify_history: [],
      });
      carrier?.file_ids.push(p.file_id);
      batch?.file_ids.push(p.file_id);
      break;
    }

    case EVENT_TYPES.DIGITIZATION_VERIFIED: {
      const file = state.files.get(p.file_id);
      if (!file) break;
      file.verify_history.push({
        expected_sha256: p.expected_sha256 ?? file.sha256,
        actual_sha256: p.actual_sha256,
        ok: Boolean(p.ok),
        verifier: event.actor?.name ?? p.verifier ?? null,
        at,
      });
      // 校验通过才置为已验证；失败保留状态并留下记录
      if (p.ok) file.verified = true;
      break;
    }

    case EVENT_TYPES.SEGMENT_DEFINED: {
      const carrier = state.carriers.get(p.carrier_id);
      state.segments.set(p.segment_id, {
        segment_id: p.segment_id,
        carrier_id: p.carrier_id,
        label: p.label ?? null,
        // 声道切分：channel 标识来源声道（L/R/mono/…）
        channel: p.channel ?? "mono",
        start_ms: p.start_ms,
        end_ms: p.end_ms,
        source_file_ids: [...(p.source_file_ids ?? [])],
        parent_segment_id: p.parent_segment_id ?? null,
        subjects: [...(p.subjects ?? [])],
        language: p.language ?? null,
        recorded_period: p.recorded_period ?? null,
        recorded_at: p.recorded_at ?? null,
        status: STATUS.ACTIVE,
        defined_at: at,
      });
      carrier?.segment_ids.push(p.segment_id);
      break;
    }

    case EVENT_TYPES.PERSON_RECORDED: {
      state.persons.set(p.person_id, {
        person_id: p.person_id,
        display_name: p.display_name,
        names: (p.names ?? [{ value: p.display_name, type: "primary" }]).map((n) => ({
          value: n.value,
          type: n.type ?? "alias",
          note: n.note ?? null,
        })),
        born: p.born ?? null,
        died: p.died ?? null,
        // 是否为获准公开人物；亲属默认不公开
        public: Boolean(p.public),
        is_kin: Boolean(p.is_kin),
        description_public: p.description_public ?? null,
      });
      break;
    }

    case EVENT_TYPES.SPEAKER_ANNOTATED:
    case EVENT_TYPES.SPEAKER_CANDIDATE_PROPOSED: {
      const identity = ensure(state.identities, p.segment_id, () => ({
        identity_id: p.identity_id,
        segment_id: p.segment_id,
        status: "undetermined",
        decided_person_id: null,
        candidates: [],
        notes: [],
      }));
      const candidate = p.candidate ?? {
        person_id: p.person_id,
        confidence: p.confidence,
        evidence: p.evidence ?? null,
      };
      if (candidate.person_id) {
        identity.candidates.push({
          person_id: candidate.person_id,
          confidence: candidate.confidence ?? null,
          evidence: candidate.evidence ?? null,
          status: "proposed",
          proposed_by: event.actor?.name ?? p.proposed_by ?? null,
          proposed_at: at,
        });
      }
      if (p.note) identity.notes.push({ body: p.note, at, by: event.actor?.name ?? null });
      break;
    }

    case EVENT_TYPES.SPEAKER_CANDIDATE_RESOLVED: {
      const identity = ensure(state.identities, p.segment_id, () => ({
        identity_id: p.identity_id,
        segment_id: p.segment_id,
        status: "undetermined",
        decided_person_id: null,
        candidates: [],
        notes: [],
      }));
      if (p.person_id === null || p.person_id === undefined) {
        // 纠正：撤销原认定，回到“无法确认”
        identity.status = "undetermined";
        identity.decided_person_id = null;
      } else {
        identity.status = "confirmed";
        identity.decided_person_id = p.person_id;
        for (const c of identity.candidates) {
          if (c.person_id === p.person_id) c.status = "confirmed";
          else if (c.status === "confirmed") c.status = "rejected";
        }
      }
      identity.resolution = {
        certainty: p.certainty ?? "confirmed",
        reason: p.reason ?? null,
        by: event.actor?.name ?? p.resolved_by ?? null,
        at,
      };
      break;
    }

    case EVENT_TYPES.TRANSCRIPT_RECORDED:
    case EVENT_TYPES.TRANSCRIPT_CORRECTED: {
      const bucket = ensure(state.transcripts, p.segment_id, () => ({
        current: null,
        revisions: [],
      }));
      const revisionNo = bucket.revisions.length + 1;
      const revision = {
        revision_id: p.revision_id,
        segment_id: p.segment_id,
        revision_no: revisionNo,
        text: p.text,
        mentions: (p.mentions ?? []).map((m) => ({ ...m })),
        editor: event.actor?.name ?? p.editor ?? null,
        change_kind: event.event_type === EVENT_TYPES.TRANSCRIPT_CORRECTED ? "correction" : "initial",
        changes: (p.changes ?? []).map((c) => ({ ...c })),
        supersedes_revision_id: p.supersedes_revision_id ?? null,
        note: p.note ?? null,
        event_id: event.event_id,
        created_at: at,
      };
      bucket.revisions.push(revision);
      bucket.current = revision;
      break;
    }

    case EVENT_TYPES.REVIEW_NOTE_ADDED: {
      const list = ensure(state.notes, p.segment_id, () => []);
      list.push({
        note_id: p.note_id,
        segment_id: p.segment_id,
        author: event.actor?.name ?? p.author ?? null,
        author_role: event.actor?.role ?? null,
        body: p.body,
        kind: p.note_kind ?? "general",
        status: "open",
        at,
      });
      // 意见只追加、并存，不覆盖既有意见
      break;
    }

    case EVENT_TYPES.SONG_RIGHTS_RECORDED: {
      const list = ensure(state.songRights, p.segment_id, () => []);
      list.push({
        rights_id: p.rights_id,
        segment_id: p.segment_id,
        song_title: p.song_title,
        rights_holder: p.rights_holder ?? null,
        status: p.status, // cleared | pending | denied
        license: p.license ?? null,
        valid_from: p.valid_from ?? null,
        valid_to: p.valid_to ?? null,
        note: p.note ?? null,
        at,
      });
      break;
    }

    case EVENT_TYPES.RELEASE_DECIDED:
    case EVENT_TYPES.RELEASE_APPROVED: {
      const list = ensure(state.decisions, p.segment_id, () => []);
      const decision = {
        decision_id: p.decision_id ?? event.event_id,
        segment_id: p.segment_id,
        // 既有 RELEASE_APPROVED 事件语义等价于 action=open 的开放决定
        action: event.event_type === EVENT_TYPES.RELEASE_APPROVED ? "open" : p.action,
        basis: p.basis ?? "public_interest",
        reason: p.reason ?? p.summary ?? null,
        decided_by: event.actor?.name ?? p.decided_by ?? null,
        // valid_from/valid_until 只表达“业务生效窗口”（如纪念敏感期）。
        // 决定何时作出由事件 occurred_at 承担，foldAt 已按时过滤，
        // 不把事件时间回填为 valid_from，避免与当前时间的毫秒级竞态。
        valid_from: p.valid_from ?? null,
        valid_until: p.valid_until ?? null,
        decided_at: at,
        mask: p.mask ? { text_spans: [...(p.mask.text_spans ?? [])], audio_ranges_ms: [...(p.mask.audio_ranges_ms ?? [])] } : null,
        legacy_event: event.event_type === EVENT_TYPES.RELEASE_APPROVED,
      };
      list.push(decision);
      break;
    }

    case EVENT_TYPES.SEGMENT_WITHDRAWN: {
      const segment = state.segments.get(p.segment_id);
      if (segment) segment.status = STATUS.WITHDRAWN;
      state.withdrawals.set(p.segment_id, {
        reason: p.reason,
        basis: p.basis ?? null,
        until: p.until ?? null,
        scope_derivatives: p.scope_derivatives !== false,
        withdrawn_by: event.actor?.name ?? p.withdrawn_by ?? null,
        at,
      });
      break;
    }

    case EVENT_TYPES.SEGMENT_RESTORED: {
      const segment = state.segments.get(p.segment_id);
      if (segment) segment.status = STATUS.ACTIVE;
      state.withdrawals.delete(p.segment_id);
      break;
    }

    default:
      break;
  }
  return state;
}

export function fold(events) {
  const state = createEmptyState();
  for (const e of events) applyEvent(state, e);
  return state;
}

/**
 * 时点重放：归约 occurred_at <= at 的事件，得到某一时刻的目录状态。
 * 同一时刻多条事件按追加顺序应用（store 顺序即因果顺序）。
 * 供“下架期间/纪念期内的历史视图”与引用状态回溯使用。
 */
export function foldAt(events, at) {
  const cutoff = Date.parse(typeof at === "string" ? at : new Date(at).toISOString());
  const state = createEmptyState();
  for (const e of events) {
    if (Date.parse(e.occurred_at) <= cutoff) applyEvent(state, e);
  }
  return state;
}

/**
 * 片段的衍生文件闭包：
 *  根集合 = 直接绑定该片段的派生文件
 *         + 同载体上未绑定具体片段的整盘派生件（整盘降噪件等，内容覆盖该片段）；
 * 再沿 derived_from 边向下收集这些根的后续派生版本。
 * 注意：保存母带是各段访问件的共同来源（汇合点），不得沿母带反向波及兄弟切分，
 * 因此母带/原始采集既不属于闭包根，也不向下扩散。
 * 临时下架据此只连带相应片段与确实含其内容的衍生文件。
 */
export function derivedFilesForSegment(state, segmentId) {
  const segment = state.segments.get(segmentId);
  if (!segment) return [];
  const rootIds = new Set();
  for (const f of state.files.values()) {
    if (f.role === "original_capture" || f.role === "preservation_master") continue;
    if (f.segment_id === segmentId) rootIds.add(f.file_id);
    // 整盘派生件（无片段绑定且同载体）包含该片段内容
    if (!f.segment_id && f.carrier_id === segment.carrier_id) rootIds.add(f.file_id);
  }

  const found = new Map([...rootIds].map((id) => [id, state.files.get(id)]).filter(([, f]) => f));
  const frontier = [...rootIds];
  while (frontier.length) {
    const parentId = frontier.pop();
    for (const f of state.files.values()) {
      if (f.derived_from_file_id === parentId && !found.has(f.file_id)) {
        found.set(f.file_id, f);
        frontier.push(f.file_id);
      }
    }
  }
  return [...found.values()];
}

/**
 * 取片段当前“在有效期内”的开放决定（最新者优先）；无有效决定返回 null。
 * 纪念敏感期等时效性依据通过 valid_until 表达：过期后自动回落到更早的开放决定。
 * 时间一律按毫秒比较，避免不同时区偏移的字符串词法比较错误。
 */
export function effectiveDecision(state, segmentId, now = new Date()) {
  const list = state.decisions.get(segmentId);
  if (!list) return null;
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const d = list[i];
    if (d.valid_from && Date.parse(d.valid_from) > nowMs) continue;
    if (d.valid_until && Date.parse(d.valid_until) <= nowMs) continue;
    return d;
  }
  return null;
}
