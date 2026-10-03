// 编目投影：从折叠状态生成读者检索与稳定引用所需视图。
// 投影不落库为事实——任何时刻都可由事件日志重建；访问过滤一律委托 policy。

import { evaluateSegment } from "../domain/policy.js";
import { citationRef } from "../domain/identifiers.js";

const CITATION_PATTERN = /^nlc-oh\/([^/]+)\/([^/@]+)(?:@v(\d+))?$/;

export function parseCitation(ref) {
  const m = CITATION_PATTERN.exec(ref);
  if (!m) return null;
  return { carrier_id: m[1], segment_id: m[2], version: m[3] ? Number(m[3]) : null };
}

function tokenize(text) {
  if (!text) return [];
  return [...text.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)].map((m) => m[0]);
}

/** 简易中文/英文混合索引：对姓名、别名、主题与逐字稿全文做包含匹配 */
function haystackFor(state, segment) {
  const parts = [...(segment.topics ?? [])];
  const carrier = state.carriers.get(segment.carrier_id);
  if (carrier) {
    parts.push(carrier.title, carrier.tape_no, carrier.recorded_on);
  }
  for (const ref of segment.people_mentioned ?? []) {
    const p = state.persons.get(ref.person_id ?? ref);
    // 私人人物（如背景第三人家属）不得进入任何公开检索词
    if (p && p.visibility !== "private") {
      parts.push(p.display_name, ...p.aliases.map((a) => a.alias));
    }
  }
  for (const c of segment.speaker_candidates ?? []) {
    if (c.status === "withdrawn" || c.status === "superseded") continue;
    const pc = c.person_id ? state.persons.get(c.person_id) : null;
    if (pc && pc.visibility !== "private") parts.push(pc.display_name, ...pc.aliases.map((a) => a.alias));
    if (c.proposed_name && c.status === "confirmed") parts.push(c.proposed_name);
  }
  for (const songId of segment.song_ids ?? []) parts.push(state.songs.get(songId)?.current?.title);
  // 注意：逐字稿全文不放入此索引；检索时须使用经开放策略过滤后的可见文字，
  // 否则被遮蔽的家事内容会经全文检索逃逸。
  return parts.filter(Boolean).join("\n");
}

export class Catalog {
  constructor(state) {
    this.state = state;
  }

  segmentAccess(segmentId, viewer, now) {
    return evaluateSegment(this.state, segmentId, viewer, now);
  }

  /** 到期复核清单：暂缓决定带 review_after 且已到期（不自动开放，须馆员作新决定） */
  decisionsDueForReview(now = new Date()) {
    const out = [];
    for (const [decisionId, d] of this.state.decisions) {
      const cur = d.versions[d.current_version - 1];
      if (cur?.review_after && new Date(cur.review_after).getTime() <= now.getTime()) {
        out.push({
          decision_id: decisionId,
          segment_id: d.segment_id,
          disposition: cur.disposition,
          review_after: cur.review_after,
          bases: cur.bases,
        });
      }
    }
    return out;
  }

  /**
   * 解析稳定引用。即使片段已临时下架或逐字稿已修订，引用仍可解析：
   *  - 无版本号：指向当前版，附带版本变化说明；
   *  - @vN：指向当时文本（研究出处），并给出从 vN 到当前的修订链；
   *  - 下架/暂缓：书目信息仍可解析，正文与音频按授权边界返回。
   */
  resolveCitation(ref, viewer = { role: "public" }, now = new Date()) {
    const parsed = parseCitation(ref);
    if (!parsed) return { status: "malformed", ref };
    const { carrier_id, segment_id, version } = parsed;
    const segment = this.state.segments.get(segment_id);
    if (!segment || segment.carrier_id !== carrier_id) return { status: "not_found", ref, ...parsed };

    const access = evaluateSegment(this.state, segment_id, viewer, now);
    const transcript = this.state.transcripts.get(`tr-${segment_id}`);
    const versions = transcript?.versions ?? [];
    const currentVersion = transcript?.current_version ?? null;
    const target = version ? versions.find((v) => v.version === version) : versions.at(-1) ?? null;

    if (version && !target) {
      return { status: "version_not_found", ref, ...parsed, current_version: currentVersion };
    }

    const revisionChain = target
      ? versions
          .filter((v) => v.version >= target.version)
          .map((v) => ({
            version: v.version,
            event_id: v.event_id,
            at: v.at,
            editor: v.editor,
            change_summary: v.change_summary,
            corrections: v.corrections,
            based_on_version: v.based_on_version,
          }))
      : [];

    const canSeeText = ["open", "masked"].includes(access.status);
    let text = target?.text ?? null;
    let textMode = target ? "full" : "none";
    if (target && canSeeText) {
      // 现行遮蔽决定同样适用于历史版本：隐私不随旧版逃逸
      const masking = access.decision?.masking;
      if (access.status === "masked" && masking?.redact_spans?.length) {
        const chars = [...text];
        for (const span of masking.redact_spans) {
          for (let i = Math.max(0, span.start_offset); i < Math.min(chars.length, span.end_offset); i++) {
            chars[i] = "█";
          }
        }
        text = chars.join("");
        textMode = "redacted";
      }
    } else if (target && !canSeeText) {
      text = null;
      textMode = "withheld";
    }

    const speaker = access.status === "open" || access.status === "masked"
      ? access.speaker
      : { confirmed: null, candidates: [] };

    return {
      status: "resolved",
      ref,
      carrier_id,
      segment_id,
      time_range: segment.time_range,
      channel: segment.channel,
      topics: segment.topics,
      speaker,
      cited_transcript: target
        ? {
            version: target.version,
            event_id: target.event_id,
            at: target.at,
            text,
            text_mode: textMode,
          }
        : null,
      current_version: currentVersion,
      superseded: Boolean(target && currentVersion && target.version < currentVersion),
      version_history: revisionChain,
      access: {
        status: access.status,
        audio: access.audio,
        current_transcript_version: access.transcript_version ?? null,
        decision_event: access.decision_event,
        withdrawal: access.withdrawal,
        withheld_reasons: access.withheld_reasons,
        masked_reasons: access.masked_reasons,
      },
      canonical_ref: citationRef(segment_id, carrier_id, currentVersion),
    };
  }

  /**
   * 读者检索。只返回查看者此刻可抵达的片段；命中结果直接携带可播放资产与文字。
   * q 为自由词（姓名/旧称/主题/全文）；filters 可限定时间、主题、人物。
   */
  search({ q, person_id, topic, year, from, to } = {}, viewer = { role: "public" }, now = new Date()) {
    const needle = q ? q.toLowerCase() : null;
    const hits = [];
    for (const segment of this.state.segments.values()) {
      const access = evaluateSegment(this.state, segment.segment_id, viewer, now);
      if (!["open", "masked"].includes(access.status)) continue;

      const haystack = haystackFor(this.state, segment);
      // 可见文字 = 开放策略处理后的逐字稿（遮蔽片段此处已是涂黑文本）
      const visibleText =
        access.transcript && access.transcript.mode !== "none" ? access.transcript.text : null;
      if (needle) {
        const inMeta = haystack.toLowerCase().includes(needle);
        const inVisibleText = Boolean(visibleText && visibleText.toLowerCase().includes(needle));
        if (!inMeta && !inVisibleText) continue;
      }

      if (person_id) {
        const mentioned = (segment.people_mentioned ?? []).some(
          (r) => (r.person_id ?? r) === person_id,
        );
        const spoken = segment.speaker_candidates.some(
          (c) => c.status === "confirmed" && c.person_id === person_id,
        );
        if (!mentioned && !spoken) continue;
        // 私人人物不得因提及而被检索出来
        const p = this.state.persons.get(person_id);
        if (p && p.visibility === "private" && !isStaffViewer(viewer)) continue;
      }
      if (topic && !(segment.topics ?? []).includes(topic)) continue;

      const carrier = this.state.carriers.get(segment.carrier_id);
      const recorded = carrier?.recorded_on ?? null;
      if (year && (!recorded || !recorded.startsWith(String(year)))) continue;
      if (from && (!recorded || recorded < from)) continue;
      if (to && (!recorded || recorded > to)) continue;

      const transcript = this.state.transcripts.get(`tr-${segment.segment_id}`);
      const t = transcript?.versions[transcript.current_version - 1] ?? null;
      hits.push({
        segment_id: segment.segment_id,
        carrier_id: segment.carrier_id,
        carrier_title: carrier?.title ?? null,
        recorded_on: recorded,
        time_range: segment.time_range,
        channel: segment.channel,
        topics: segment.topics,
        speaker: access.speaker,
        snippet: visibleText ? makeSnippet(visibleText, q) : null,
        transcript_version: t?.version ?? null,
        access_status: access.status,
        audio: access.audio,
        citation: citationRef(segment.segment_id, segment.carrier_id, t?.version),
      });
    }
    return { query: q ?? null, count: hits.length, results: hits };
  }

  /** 磁带编目视图：公开视角剥离原始库位、保管细节与捐赠人信息 */
  describeCarrier(carrierId, viewer = { role: "public" }, now = new Date()) {
    const carrier = this.state.carriers.get(carrierId);
    if (!carrier) return { status: "not_found", carrier_id: carrierId };
    const staff = isStaffViewer(viewer);

    const segments = [...this.state.segments.values()]
      .filter((s) => s.carrier_id === carrierId)
      .map((s) => {
        const access = evaluateSegment(this.state, s.segment_id, viewer, now);
        return {
          segment_id: s.segment_id,
          time_range: s.time_range,
          channel: s.channel,
          topics: s.topics,
          status: access.status,
          citation: citationRef(
            s.segment_id,
            carrierId,
            this.state.transcripts.get(`tr-${s.segment_id}`)?.current_version,
          ),
        };
      });

    const publicSegments = segments.filter((s) => ["open", "masked"].includes(s.status));
    if (!staff && publicSegments.length === 0) {
      return { status: "forbidden", carrier_id: carrierId };
    }

    const batchInfo = [...this.state.files.values()]
      .filter((f) => f.carrier_id === carrierId && f.role === "original_capture")
      .map((f) => ({
        file_id: f.file_id,
        role: f.role,
        batch_id: f.batch_id,
        codec: f.codec,
        checksums: f.checksums,
      }));

    const publicFiles = [...this.state.files.values()]
      // 公开磁带页同样只发放访问代理；降噪处理母版不外露
      .filter((f) => f.carrier_id === carrierId && f.role === "derived" && f.kind === "access_proxy")
      .map((f) => ({
        file_id: f.file_id,
        kind: f.kind,
        source_kind: this.state.files.get(f.source_file_id)?.role ?? null,
        codec: f.codec,
        checksums: f.checksums,
      }));

    const view = {
      status: "resolved",
      carrier_id: carrierId,
      title: carrier.title,
      tape_no: carrier.tape_no,
      media_type: carrier.media_type,
      duration_ms: carrier.duration_ms,
      recorded_on: carrier.recorded_on,
      segments: staff ? segments : publicSegments,
      files: staff ? batchInfo : publicFiles,
    };
    if (staff) {
      view.original_location = carrier.original_location;
      view.agreement_ids = carrier.agreement_ids;
      view.custody = this.state.custodies.get(carrierId) ?? [];
      view.agreements = carrier.agreement_ids.map((id) => this.state.agreements.get(id)).filter(Boolean);
    }
    return view;
  }
}

function isStaffViewer(viewer) {
  return Boolean(viewer && ["cataloger", "reviewer", "rights_officer", "release_officer", "admin"].includes(viewer.role));
}

function makeSnippet(text, q, radius = 36) {
  if (!q) return text.slice(0, 80);
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 80);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + q.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export { tokenize };
