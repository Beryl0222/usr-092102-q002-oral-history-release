/**
 * 稳定引用（研究引用）。
 *
 * 引用标识形如（segment_id 自身带 seg- 前缀）：
 *   nlc-oh:seg-kl-03-01@rev-seg01-002
 *   nlc-oh:seg-kl-03-01@rev-seg01-002#t=12.5
 *   nlc-oh:seg-kl-03-01@current#t=12.5
 *
 * 语义保证：
 *  - 引用钉住“片段 + 逐字稿修订版本”，后续校订不会改写被引文字，旧版本永久可取；
 *  - 被引版本不是最新时，解析结果附 supersession 链与修订点（changes），
 *    使既有研究“出处仍在、且能解释后来为什么改”；
 *  - 片段临时下架时引用不返回 404：返回引用解释与状态（含下架依据、时间），
 *    仅屏蔽正文与音频；恢复后原引用立即再次有效；
 *  - 衍生文件被下架连带时，引用的 file 部分标记 unavailable 并给出替代访问件（若有）。
 */
import { createHash } from "node:crypto";
import { accessibleFiles, renderTranscript, resolveAccess, ROLES, roleAtLeast } from "./access-policy.js";

export const CITATION_PREFIX = "nlc-oh";

export function formatCitation(segmentId, revisionId = "current", anchorSeconds = null) {
  let c = `${CITATION_PREFIX}:${segmentId}@${revisionId}`;
  if (anchorSeconds != null) c += `#t=${anchorSeconds}`;
  return c;
}

export function parseCitation(ref) {
  const m = /^nlc-oh:(?<seg>seg-[^@#]+)@(?<rev>[^#]+)(?:#t=(?<t>[\d.]+))?$/.exec(ref);
  if (!m) return null;
  return {
    segment_id: m.groups.seg,
    revision_id: m.groups.rev === "current" ? null : m.groups.rev,
    anchor_seconds: m.groups.t ? Number(m.groups.t) : null,
  };
}

function checksum(text) {
  return createHash("sha256").update(text ?? "").digest("hex").slice(0, 16);
}

/**
 * 解析引用为“引用对象”。content 的可见性按角色过滤；
 * 但无论角色与开放状态，引用本身（标识、版本、状态说明）总能解析。
 */
export function resolveCitation(state, ref, { role = ROLES.PUBLIC, now = new Date().toISOString() } = {}) {
  const parsed = parseCitation(ref);
  if (!parsed) {
    return { ref, resolvable: false, error: "引用格式无法识别" };
  }
  const { segment_id: segmentId, revision_id: revisionId } = parsed;
  const seg = state.segments.get(segmentId);
  if (!seg) {
    return { ref, resolvable: false, error: "引用的片段标识在目录中不存在（标识可能抄写有误）" };
  }

  const access = resolveAccess(state, segmentId, now);
  const bucket = state.transcripts.get(segmentId);
  const revision = revisionId
    ? bucket?.revisions.find((r) => r.revision_id === revisionId)
    : bucket?.current;

  const carrier = state.carriers.get(seg.carrier_id);
  const result = {
    ref,
    resolvable: true,
    segment_id: segmentId,
    carrier: { carrier_id: seg.carrier_id, title: carrier?.title ?? null },
    anchor_seconds: parsed.anchor_seconds,
    cited_revision_id: revision?.revision_id ?? revisionId,
    current_revision_id: bucket?.current.revision_id ?? null,
    version_history: (bucket?.revisions ?? []).map((r) => ({
      revision_id: r.revision_id,
      revision_no: r.revision_no,
      change_kind: r.change_kind,
      created_at: r.created_at,
      checksum16: checksum(r.text),
    })),
    access_state: access.state,
    access_explanation: access.reasons,
    valid_until: access.decision?.valid_until ?? access.withdrawal?.until ?? null,
  };

  if (revisionId && !revision) {
    result.status_note = "被引修订版本缺失：请核对引用标识";
    return result;
  }
  if (!revision) {
    result.status_note = "该片段尚无逐字稿";
    return result;
  }

  // 版本变化解释
  if (bucket.current.revision_id !== revision.revision_id) {
    const newer = bucket.revisions.filter((r) => r.revision_no > revision.revision_no);
    result.superseded = {
      current_revision_id: bucket.current.revision_id,
      newer_revisions: newer.map((r) => ({
        revision_id: r.revision_id,
        supersedes: r.supersedes_revision_id,
        changes: r.changes,
        editor: roleAtLeast(role, ROLES.EDITOR) ? r.editor : null,
        created_at: r.created_at,
      })),
      note: "引用的文字版本已被后续校订接替；被引原文保留如下，差异见 newer_revisions.changes。",
    };
  }

  // 被引文字按当时版本渲染并施加当前遮蔽（亲属隐私等强制规则不因引用而豁免）
  const rendered = renderTranscript(state, segmentId, { revisionId: revision.revision_id, role, now });
  result.quoted = {
    revision_id: rendered.revision_id,
    checksum16: checksum(revision.text),
    text: rendered.text,
    masked: rendered.masked,
    blocked_reason: rendered.blocked_reason,
  };

  // 文件引用：下架/暂缓连带衍生文件，任何角色都不从开放接口取得受限音频
  result.files = accessibleFiles(state, segmentId, { role, now });
  if ((access.state === "withdrawn" || access.state === "withheld") && result.files.length === 0) {
    result.files_status = "音频暂不可用（临时下架/暂缓，仅影响本片段及其衍生文件）";
  }

  // 生成面向出版的规范引注
  result.bibliographic = {
    label: `${carrier?.title ?? seg.carrier_id}·${seg.label ?? segmentId}`,
    citation: `${carrier?.title ?? seg.carrier_id}，${seg.label ?? segmentId}（${seg.recorded_period ?? "录制时间待考"}），中国记忆项目·抗联录音开放编目，${ref}`,
  };
  return result;
}
