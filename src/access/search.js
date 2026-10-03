/**
 * 读者检索投影。
 *
 * 只收录读者当前可访问（open/masked）的片段；文字按读者视角渲染，
 * 未公开亲属姓名与受限内容不进入索引，因此“搜索”本身不会泄露边界外信息。
 * 命中结果直接给出片段锚点（含时间码）与当前可信文字版本。
 */
import { renderTranscript, resolveAccess, canAccessAudio, ROLES } from "./access-policy.js";

function tokenize(text) {
  if (!text) return [];
  // 中文按字二元组 + 拉丁/数字词，兼顾人名旧称与主题词
  const lowered = text.toLowerCase();
  const latin = lowered.match(/[a-z0-9]+/g) ?? [];
  const cjkRuns = lowered.match(/[一-鿿]+/g) ?? [];
  const grams = [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i += 1) grams.push(run.slice(i, i + 2));
  }
  return [...latin, ...grams, ...cjkRuns];
}

export class SearchIndex {
  constructor(state, { now = new Date().toISOString() } = {}) {
    this.now = now;
    this.docs = [];
    for (const seg of state.segments.values()) {
      const access = resolveAccess(state, seg.segment_id, now);
      if (!canAccessAudio(access)) continue;

      const transcript = renderTranscript(state, seg.segment_id, { role: ROLES.PUBLIC, now });
      const carrier = state.carriers.get(seg.carrier_id);

      // 获准人物：已确认且公开的说话人，姓名（含旧称/别名）全部入索引
      const personNames = [];
      const identity = state.identities.get(seg.segment_id);
      if (identity?.status === "confirmed" && identity.decided_person_id) {
        const person = state.persons.get(identity.decided_person_id);
        if (person?.public) {
          personNames.push(person.display_name);
          for (const n of person.names) personNames.push(n.value);
        }
      }

      // 未公开人物（含背景第三人/亲属）绝不进索引
      const text = transcript?.text ?? "";
      const haystack = [
        text,
        seg.label ?? "",
        (seg.subjects ?? []).join(" "),
        personNames.join(" "),
        seg.recorded_period ?? "",
        seg.recorded_at ?? "",
        carrier?.title ?? "",
      ].join("\n");

      this.docs.push({
        segment_id: seg.segment_id,
        carrier_id: seg.carrier_id,
        carrier_title: carrier?.title ?? null,
        label: seg.label,
        time_range_ms: { start_ms: seg.start_ms, end_ms: seg.end_ms },
        subjects: seg.subjects,
        persons: [...new Set(personNames)],
        recorded_period: seg.recorded_period,
        recorded_at: seg.recorded_at,
        access_state: access.state,
        current_revision_id: transcript?.revision_id ?? null,
        snippet_text: text,
        _tokens: new Set(tokenize(haystack)),
      });
    }
  }

  /**
   * @param {{q?: string, person?: string, year?: number|string, subject?: string}} query
   */
  search(query = {}) {
    let results = this.docs;
    if (query.person) {
      const p = query.person.trim().toLowerCase();
      results = results.filter((d) => d.persons.some((n) => n.toLowerCase().includes(p)));
    }
    if (query.subject) {
      const s = query.subject.trim().toLowerCase();
      results = results.filter((d) => d.subjects.some((t) => t.toLowerCase().includes(s)));
    }
    if (query.year !== undefined && query.year !== null && query.year !== "") {
      const y = String(query.year);
      results = results.filter(
        (d) =>
          (d.recorded_at && d.recorded_at.startsWith(y)) ||
          (d.recorded_period && d.recorded_period.includes(y)),
      );
    }
    if (query.q) {
      const terms = tokenize(query.q);
      results = results
        .map((d) => {
          let hits = 0;
          for (const t of terms) if (d._tokens.has(t)) hits += 1;
          return { d, hits };
        })
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .map((x) => x.d);
    }
    return results.map(({ _tokens, ...rest }) => rest);
  }
}
