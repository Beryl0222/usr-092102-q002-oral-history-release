// 开放策略：把当前折叠状态与查看者身份组合成"此刻对此片段能看到什么"。
// 三类依据各自独立：
//   memorial_sensitivity 纪念敏感期（带 review_after，到期前暂缓）
//   family_privacy       亲属隐私/背景第三人家事（遮蔽或暂缓，按决定执行）
//   donation_restriction  捐赠协议限制（协议本身可带期限与范围，效力高于既有开放决定）
// 临时下架（SEGMENT_WITHDRAWN）独立于开放决定：只影响该片段时间窗及其衍生文件，
// 不改动磁带、其他片段和逐字稿版本；恢复后决定继续有效。

const STAFF_ROLES = new Set(["cataloger", "reviewer", "rights_officer", "release_officer", "admin"]);

const REDACT = "█";

export function isStaff(viewer) {
  return Boolean(viewer && STAFF_ROLES.has(viewer.role));
}

/** 捐赠协议对某片段此刻是否存在限制 */
function donationConstraints(state, segment) {
  const out = [];
  const agreementIds = state.carriers.get(segment.carrier_id)?.agreement_ids ?? [];
  for (const id of agreementIds) {
    const a = state.agreements.get(id);
    if (!a) continue;
    for (const r of a.restrictions ?? []) {
      const rule = typeof r === "string" ? { code: r, scope: "carrier" } : r;
      if (rule.until && new Date(rule.until).getTime() <= Date.now()) continue; // 限制已到期
      const scopeAll = !rule.scope || rule.scope === "carrier" || rule.scope === "all";
      const inScope =
        scopeAll ||
        (rule.scope === "segments" && (rule.segment_ids ?? []).includes(segment.segment_id));
      if (inScope) {
        out.push({
          kind: "donation_restriction",
          code: rule.code ?? "donation_restriction",
          effect: rule.effect ?? "withhold",
          until: rule.until ?? null,
          agreement_id: id,
          note: rule.note ?? null,
        });
      }
    }
  }
  return out;
}

/** 歌曲权利的现行约束：未决权利至少遮蔽音频 */
function songConstraints(state, segment) {
  const out = [];
  for (const songId of segment.song_ids ?? []) {
    const song = state.songs.get(songId);
    const cur = song?.current;
    if (cur && cur.work_status === "unresolved") {
      out.push({
        kind: "song_rights",
        song_id: songId,
        title: cur.title,
        effect: "mask_audio",
        license: cur.license ?? null,
      });
    }
  }
  return out;
}

function activeWithdrawal(segment) {
  return segment.withdrawals.find((w) => w.restored_event === null) ?? null;
}

function applyRedactionSpans(text, spans) {
  if (!spans || spans.length === 0) return text;
  const chars = [...text];
  for (const span of [...spans].sort((a, b) => a.start_offset - b.start_offset)) {
    const s = Math.max(0, span.start_offset);
    const e = Math.min(chars.length, span.end_offset);
    for (let i = s; i < e; i++) chars[i] = REDACT;
  }
  return chars.join("");
}

/**
 * 评估单个片段在某查看者视角下的可见性。
 * @returns {object} status: open | masked | withheld | withdrawn | undecided
 */
export function evaluateSegment(state, segmentId, viewer = { role: "public" }, now = new Date()) {
  const segment = state.segments.get(segmentId);
  if (!segment) return { status: "not_found", segment_id: segmentId };

  const decision = state.decisions.get(`rd-${segmentId}`);
  const current = decision?.versions[decision.current_version - 1] ?? null;
  const withdrawal = activeWithdrawal(segment);
  const donation = donationConstraints(state, segment);
  const songs = songConstraints(state, segment);
  const transcript = state.transcripts.get(`tr-${segmentId}`);
  const currentTranscript = transcript?.versions[transcript.current_version - 1] ?? null;

  const staff = isStaff(viewer);
  const base = {
    segment_id: segmentId,
    carrier_id: segment.carrier_id,
    time_range: segment.time_range,
    channel: segment.channel,
    topics: segment.topics,
    decision_event: current?.event_id ?? null,
    decision_version: current?.version ?? null,
    transcript_version: currentTranscript?.version ?? null,
    constraints: { donation, songs: songs.map(({ kind, ...rest }) => ({ kind, ...rest })) },
    staff_view: staff,
  };

  // 工作人员在编目边界内可见全部素材（含原始采集与库位），但操作授权仍由命令层角色控制
  if (staff) {
    return {
      ...base,
      status: "open",
      audio: { mode: "full", assets: listAssets(state, segment, { staff: true }) },
      transcript: currentTranscript
        ? { mode: "full", text: currentTranscript.text, version: currentTranscript.version }
        : { mode: "none" },
      speaker: speakerView(state, segment),
      withdrawal: withdrawal ? { active: true, ...withdrawal } : { active: false },
      decision: current,
    };
  }

  // 1) 临时下架优先：只关这一个片段的时间窗及其衍生文件
  if (withdrawal) {
    return {
      ...base,
      status: "withdrawn",
      withdrawal: { active: true, reason: withdrawal.reason, at: withdrawal.at, expected_restore_after: withdrawal.expected_restore_after },
      audio: { mode: "none" },
      transcript: { mode: "none" },
      decision: current,
      speaker: { confirmed: null, candidates: [] },
    };
  }

  // 2) 捐赠协议限制效力高于既有开放决定
  const hardDonation = donation.find((d) => d.effect === "withhold");
  if (hardDonation) {
    return {
      ...base,
      status: "withheld",
      withheld_reasons: [hardDonation],
      audio: { mode: "none" },
      transcript: { mode: "none" },
      decision: current,
      speaker: { confirmed: null, candidates: [] },
    };
  }

  // 3) 开放决定
  if (!current) {
    return {
      ...base,
      status: "undecided",
      audio: { mode: "none" },
      transcript: { mode: "none" },
      speaker: { confirmed: null, candidates: [] },
    };
  }

  // 纪念敏感期：暂缓决定到期前不开放
  if (
    current.disposition === "open" &&
    current.review_after &&
    new Date(current.review_after).getTime() > now.getTime()
  ) {
    return {
      ...base,
      status: "withheld",
      withheld_reasons: [{ kind: "memorial_sensitivity", review_after: current.review_after }],
      audio: { mode: "none" },
      transcript: { mode: "none" },
      decision: current,
      speaker: { confirmed: null, candidates: [] },
    };
  }

  if (current.disposition === "withheld") {
    return {
      ...base,
      status: "withheld",
      withheld_reasons: (current.bases ?? []).map((kind) => ({ kind })),
      audio: { mode: "none" },
      transcript: { mode: "none" },
      decision: current,
      speaker: { confirmed: null, candidates: [] },
    };
  }

  // 4) 遮蔽：音频按时间区间静音，文字按字符区间涂黑
  if (current.disposition === "masked") {
    const masking = current.masking ?? {};
    let text = currentTranscript?.text ?? null;
    if (text && masking.redact_spans?.length) {
      text = applyRedactionSpans(text, masking.redact_spans);
    }
    if (text && masking.redacted_text) text = masking.redacted_text;
    return {
      ...base,
      status: "masked",
      masked_reasons: current.bases ?? [],
      audio: {
        mode: "masked",
        assets: listAssets(state, segment, { staff: false }),
        muted_ranges: masking.audio_muted_ranges ?? [],
      },
      transcript: currentTranscript
        ? { mode: "redacted", text, version: currentTranscript.version }
        : { mode: "none" },
      speaker: publicSpeakerView(state, segment),
      decision: current,
      withdrawal: { active: false },
    };
  }

  // 5) 开放，但现行证据（如未决歌曲权利）可收窄音频开放度
  const unresolvedSongs = songs.filter((s) => s.effect === "mask_audio");
  if (unresolvedSongs.length > 0) {
    return {
      ...base,
      status: "masked",
      masked_reasons: ["song_rights"],
      audio: { mode: "masked", assets: listAssets(state, segment, { staff: false }), muted_ranges: [] },
      transcript: currentTranscript
        ? { mode: "full", text: currentTranscript.text, version: currentTranscript.version }
        : { mode: "none" },
      speaker: publicSpeakerView(state, segment),
      decision: current,
      withdrawal: { active: false },
    };
  }

  return {
    ...base,
    status: "open",
    audio: { mode: "full", assets: listAssets(state, segment, { staff: false }) },
    transcript: currentTranscript
      ? { mode: "full", text: currentTranscript.text, version: currentTranscript.version }
      : { mode: "none" },
    speaker: publicSpeakerView(state, segment),
    decision: current,
    withdrawal: { active: false },
  };
}

/** 沿溯源链列出该片段时间窗可播放的文件；非工作人员永不获得原始采集文件 */
function listAssets(state, segment, { staff }) {
  const source = state.files.get(segment.source_file_id);
  if (!source) return [];
  const all = [...state.files.values()];
  const reaches = (f, targetId) => {
    let cur = f;
    const seen = new Set();
    while (cur && !seen.has(cur.file_id)) {
      if (cur.file_id === targetId) return true;
      seen.add(cur.file_id);
      cur = cur.source_file_id ? state.files.get(cur.source_file_id) : null;
    }
    return false;
  };
  const window = segment.time_range;
  return all
    .filter((f) => reaches(f, source.file_id))
    // 公开侧只发放访问代理件；原始采集与降噪处理母版留在授权边界内
    .filter((f) => (staff ? true : f.role === "derived" && f.kind === "access_proxy"))
    .map((f) => ({
      file_id: f.file_id,
      role: f.role,
      kind: f.kind,
      source_file_id: f.source_file_id,
      codec: f.codec,
      checksums: f.checksums,
      window,
      channel: segment.channel,
    }));
}

function speakerView(state, segment) {
  const confirmed = segment.confirmed_speaker
    ? {
        person_id: segment.confirmed_speaker.person_id,
        name: state.persons.get(segment.confirmed_speaker.person_id)?.display_name ?? null,
        evidence: segment.confirmed_speaker.evidence,
      }
    : null;
  return {
    confirmed,
    candidates: segment.speaker_candidates.map((c) => ({
      candidate_id: c.candidate_id,
      person_id: c.person_id,
      proposed_name: c.proposed_name,
      confidence: c.confidence,
      status: c.status,
      disputed: c.disputed,
      basis: c.basis,
    })),
  };
}

/** 公开视角：私人人物不落名；未确认身份只显示"待考"，绝不强行定案 */
function publicSpeakerView(state, segment) {
  const view = speakerView(state, segment);
  const visiblePerson = (personId) => {
    const p = state.persons.get(personId);
    return p && p.visibility !== "private";
  };
  const pubName = (c) =>
    c.person_id && visiblePerson(c.person_id)
      ? state.persons.get(c.person_id).display_name
      : c.proposed_name && c.status === "confirmed"
        ? c.proposed_name
        : "待考";
  if (view.confirmed && visiblePerson(view.confirmed.person_id)) {
    return { confirmed: { person_id: view.confirmed.person_id, name: view.confirmed.name }, candidates: [] };
  }
  return {
    confirmed: null,
    unresolved: true,
    candidates: view.candidates
      .filter((c) => c.status !== "withdrawn")
      .map((c) => ({ candidate_id: c.candidate_id, label: pubName(c), confidence: c.confidence, status: c.status })),
  };
}
