/**
 * 开放策略与字段级授权。
 *
 * 角色：
 *   public     匿名读者（中国记忆项目网页听众）
 *   researcher 注册研究读者（持有稳定引用）
 *   editor     校订者（可看内部工作信息与候选，不可看捐赠方联系方式/库位）
 *   curator    馆员（开放审核，可见全部元数据，但受限录音的音频仍受决定约束）
 *
 * 强制原则：
 *  - 没有有效开放决定的片段，对读者一律不开放（默认关闭）；
 *  - 临时下架（可带 until 时效）优先于开放决定，但稳定引用仍可解析并解释；
 *  - 纪念敏感期依据 valid_until 到期后自动回落到更早的开放决定；
 *  - 亲属（is_kin 且未获准公开）姓名等在任何角色的读者视图中强制遮蔽，
 *    即使开放决定遗漏了 mask，也不得随文字外泄；
 *  - 原始库位、捐赠方联系方式、原始采集/保存母带文件永不离开授权边界；
 *  - 说话人“无法确认”时，候选不得作为定论对读者展示。
 */
import { effectiveDecision, derivedFilesForSegment } from "../domain/projection.js";

export const ROLES = Object.freeze({
  PUBLIC: "public",
  RESEARCHER: "researcher",
  EDITOR: "editor",
  CURATOR: "curator",
});

const ROLE_RANK = { public: 0, researcher: 1, editor: 2, curator: 3 };
export function roleAtLeast(role, min) {
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[min] ?? 3);
}

const REDACTION = "█████";

/**
 * 计算片段当前生效状态。
 * @returns {{state: string, decision: object|null, withdrawal: object|null, reasons: string[], until: string|null}}
 */
export function resolveAccess(state, segmentId, now = new Date().toISOString()) {
  const nowMs = Date.parse(typeof now === "string" ? now : new Date(now).toISOString());
  const nowIso = new Date(nowMs).toISOString();
  const reasons = [];

  const w = state.withdrawals.get(segmentId) ?? null;
  const withdrawalActive = w && (!w.until || Date.parse(w.until) > nowMs) ? w : null;
  if (w && !withdrawalActive) {
    reasons.push("临时下架期限已过，等待馆员确认恢复");
  }

  const decision = effectiveDecision(state, segmentId, nowMs);
  if (!decision) reasons.push("尚无生效的开放决定");

  let state2 = "undecided";
  if (decision) state2 = decision.action; // open | masked | withheld
  if (withdrawalActive) {
    state2 = "withdrawn";
    reasons.unshift(`临时下架：${withdrawalActive.reason}`);
  } else if (decision) {
    reasons.push(`开放决定 ${decision.action}，依据 ${decision.basis}`);
  }

  return {
    state: state2,
    decision,
    withdrawal: withdrawalActive,
    expiredWithdrawal: w && !withdrawalActive ? w : null,
    reasons,
    now: nowIso,
  };
}

/** 读者是否可访问音频字节（不含元数据与引用解释）。 */
export function canAccessAudio(access) {
  return access.state === "open" || access.state === "masked";
}

function personIsPublic(state, personId) {
  const person = state.persons.get(personId);
  return Boolean(person && person.public);
}

/**
 * 计算逐字稿“必须遮蔽”的文字区间：
 * 开放决定 mask + 指向未公开人物（多为亲属）的 mentions。
 */
export function mandatoryMaskSpans(state, revision, decision) {
  const spans = [];
  for (const s of decision?.mask?.text_spans ?? []) {
    spans.push({ start: s.start, end: s.end, reason: s.reason ?? `依据${decision.basis}` });
  }
  for (const m of revision?.mentions ?? []) {
    if (m.person_id && !personIsPublic(state, m.person_id)) {
      if (typeof m.start === "number" && typeof m.end === "number") {
        spans.push({ start: m.start, end: m.end, reason: "未公开亲属信息" });
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

export function applyTextMask(text, spans) {
  if (!spans.length) return { text, masked: false };
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  let out = "";
  let cursor = 0;
  for (const s of merged) {
    out += text.slice(cursor, s.start) + REDACTION;
    cursor = s.end;
  }
  out += text.slice(cursor);
  return { text: out, masked: true, spans: merged };
}

/** 读者可见的人物称谓：未公开者以去标识化称谓呈现。 */
export function displayPerson(state, personId, role) {
  const p = state.persons.get(personId);
  if (!p) return null;
  if (p.public || roleAtLeast(role, ROLES.CURATOR)) {
    return { person_id: p.person_id, name: p.display_name, identified: true };
  }
  return {
    person_id: p.person_id,
    name: p.is_kin ? "讲话人亲属（应隐私要求不公开姓名）" : "身份待确认者",
    identified: false,
  };
}

/**
 * 渲染某个逐字稿修订本（供稳定引用按 revision 解析）。
 * 强制遮蔽对 public/researcher/editor 生效；curator 可看原文与遮蔽标记。
 */
export function renderTranscript(state, segmentId, { revisionId = null, role = ROLES.PUBLIC, now = new Date().toISOString() } = {}) {
  const bucket = state.transcripts.get(segmentId);
  if (!bucket) return null;
  const revision = revisionId
    ? bucket.revisions.find((r) => r.revision_id === revisionId)
    : bucket.current;
  if (!revision) return null;

  const access = resolveAccess(state, segmentId, now);
  const curator = roleAtLeast(role, ROLES.CURATOR);

  // 临时下架/暂缓：非馆员不得取得正文，但引用仍能解释版本与状态。
  const contentBlocked = !curator && (access.state === "withdrawn" || access.state === "withheld");

  const decision = access.decision;
  const spans = curator ? [] : mandatoryMaskSpans(state, revision, decision);
  const rendered = applyTextMask(revision.text, spans);

  return {
    segment_id: segmentId,
    revision_id: revision.revision_id,
    revision_no: revision.revision_no,
    is_current: bucket.current.revision_id === revision.revision_id,
    supersedes: revision.supersedes_revision_id,
    superseded_by:
      bucket.current.revision_id === revision.revision_id
        ? null
        : bucket.current.revision_id,
    editor: curator || roleAtLeast(role, ROLES.EDITOR) ? revision.editor : null,
    created_at: revision.created_at,
    change_kind: revision.change_kind,
    changes: revision.changes,
    text: contentBlocked ? null : rendered.text,
    masked: rendered.masked && !contentBlocked,
    mask_spans: curator ? spans : undefined,
    blocked_reason: contentBlocked
      ? access.state === "withdrawn"
        ? "该片段临时下架，正文暂不可用；引用与版本说明保留"
        : "该片段暂缓开放"
      : null,
  };
}

/**
 * 列出片段在当前角色下可用的文件（只返回访问件/降噪件等派生访问版本）。
 * 硬边界（任何角色都不例外）：
 *  - 原始采集与保存母带永不通过开放接口出库；
 *  - 只发放“直接绑定该片段”的切分文件：整盘派生件（如整盘降噪件）同时包含其他
 *    可能受限的片段，即使本片段开放也绝不按片段发放，避免旁路听到暂缓内容；
 *  - 暂缓/临时下架的受限录音不返回任何音频文件——馆员也只能在工作区看到元数据与决定，
 *    调听走内部系统，开放后端不越界；
 *  - 遮蔽片段对访问件与片段降噪件都附带消音区间。
 */
export function accessibleFiles(state, segmentId, { role = ROLES.PUBLIC, now = new Date().toISOString() } = {}) {
  const access = resolveAccess(state, segmentId, now);
  if (!canAccessAudio(access)) return [];

  const segment = state.segments.get(segmentId);
  const files = derivedFilesForSegment(state, segmentId);
  return files
    .filter((f) => {
      if (f.role === "original_capture" || f.role === "preservation_master") return false;
      // 仅切分到本片段的文件可经开放接口发放（整盘件无 segment_id，排除）
      if (f.segment_id !== segmentId) return false;
      if (f.role === "denoised") return roleAtLeast(role, ROLES.RESEARCHER);
      return true; // access
    })
    .map((f) => ({
      file_id: f.file_id,
      role: f.role,
      mime: f.mime,
      duration_ms: f.duration_ms,
      sha256: f.sha256,
      verified: f.verified,
      derived_from_file_id: f.derived_from_file_id,
      muted_ranges_ms: access.state === "masked" ? access.decision.mask?.audio_ranges_ms ?? [] : [],
      segment_timing: { start_ms: segment?.start_ms ?? 0 },
    }));
}

/** 说话人视图：确认且公开才具名；候选仅编辑/馆员可见。 */
export function speakerView(state, segmentId, role) {
  const identity = state.identities.get(segmentId);
  if (!identity) return { status: "no_speaker_data" };

  if (identity.status === "confirmed" && identity.decided_person_id) {
    const d = displayPerson(state, identity.decided_person_id, role);
    if (d.identified) return { status: "confirmed", person: d };
    return { status: "confirmed_restricted", person: d };
  }
  const view = { status: "undetermined", candidates: [] };
  if (roleAtLeast(role, ROLES.EDITOR)) {
    view.candidates = identity.candidates.map((c) => ({
      person: displayPerson(state, c.person_id, role),
      confidence: c.confidence,
      evidence: c.evidence,
      status: c.status,
    }));
  }
  return view;
}

/** 对读者的片段目录视图（字段级过滤）。 */
export function segmentView(state, segmentId, { role = ROLES.PUBLIC, now = new Date().toISOString() } = {}) {
  const seg = state.segments.get(segmentId);
  if (!seg) return null;
  const carrier = state.carriers.get(seg.carrier_id);
  const access = resolveAccess(state, segmentId, now);
  const curator = roleAtLeast(role, ROLES.CURATOR);
  const editor = roleAtLeast(role, ROLES.EDITOR);

  const view = {
    segment_id: seg.segment_id,
    carrier_id: seg.carrier_id,
    carrier_title: carrier?.title ?? null,
    label: seg.label,
    channel: seg.channel,
    time_range_ms: { start_ms: seg.start_ms, end_ms: seg.end_ms },
    subjects: seg.subjects,
    language: seg.language,
    recorded_period: seg.recorded_period,
    recorded_at: seg.recorded_at,
    access: {
      state: access.state,
      basis: access.decision?.basis ?? null,
      reasons: editor ? access.reasons : access.reasons.slice(0, 1),
      valid_until: access.decision?.valid_until ?? access.withdrawal?.until ?? null,
    },
    speaker: speakerView(state, segmentId, role),
  };

  if (editor) {
    // 校订工作区：候选身份、并存的校订意见、决定与权利记录对校订者可见
    view.workspace = {
      source_file_ids: curator ? seg.source_file_ids : undefined,
      decisions: state.decisions.get(segmentId) ?? [],
      withdrawal: access.withdrawal,
      expired_withdrawal: access.expiredWithdrawal,
      review_notes: state.notes.get(segmentId) ?? [],
      song_rights: state.songRights.get(segmentId) ?? [],
      agreement_refs: (state.agreements.values()
        ? [...state.agreements.values()]
            .filter((a) => a.carrier_id === seg.carrier_id)
            .map((a) => ({ agreement_id: a.agreement_id, restrictions: a.restrictions, applies_segment_ids: a.applies_segment_ids }))
        : []),
    };
  }

  if (curator) {
    // 仅馆员：原始库位、捐赠方联系方式等内部保管信息
    view.internal = {
      storage_location: carrier?.storage_location ?? null,
      agreement_ids: carrier?.agreement_ids ?? [],
      source_file_ids: seg.source_file_ids,
      agreements: [...state.agreements.values()].filter((a) => a.carrier_id === seg.carrier_id),
      custody: carrier?.custody ?? [],
    };
  }
  return view;
}
