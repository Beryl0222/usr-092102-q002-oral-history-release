/**
 * CatalogQuery：读侧门面。控制器/HTTP 只与这里交互，
 * 所有授权过滤都在 access/* 内完成，写侧状态不直接对外暴露。
 */
import { foldAt } from "../domain/projection.js";
import {
  ROLES,
  accessibleFiles,
  renderTranscript,
  resolveAccess,
  segmentView,
  speakerView,
} from "./access-policy.js";
import { SearchIndex } from "./search.js";
import { formatCitation, resolveCitation } from "./citations.js";

/** 从写侧服务构造读模型；asOf 可重放到指定时刻（下架期间/纪念期历史视图）。 */
export function queryFromService(service, { asOf, now } = {}) {
  const state = asOf ? foldAt(service.store.all(), asOf) : service.state;
  return new CatalogQuery(state, { now: now ?? asOf });
}

export class CatalogQuery {
  constructor(state, { now } = {}) {
    this.state = state;
    this.defaultNow = now ?? new Date().toISOString();
  }

  _now(now) {
    return now ?? this.defaultNow;
  }

  getSegment(segmentId, { role = ROLES.PUBLIC, now } = {}) {
    const view = segmentView(this.state, segmentId, { role, now: this._now(now) });
    if (!view) return null;
    view.transcript = renderTranscript(this.state, segmentId, { role, now: this._now(now) });
    view.files = accessibleFiles(this.state, segmentId, { role, now: this._now(now) });
    view.citation_current = formatCitation(segmentId, view.transcript?.revision_id ?? "current");
    return view;
  }

  resolve(ref, { role = ROLES.PUBLIC, now } = {}) {
    return resolveCitation(this.state, ref, { role, now: this._now(now) });
  }

  search(query, { now } = {}) {
    const index = new SearchIndex(this.state, { now: this._now(now) });
    return index.search(query);
  }

  /** 载体级目录：只列读者可见片段的存在性，绝不带出库位等内部字段。 */
  listCarrier(carrierId, { role = ROLES.PUBLIC, now } = {}) {
    const carrier = this.state.carriers.get(carrierId);
    if (!carrier) return null;
    const at = this._now(now);
    const segments = carrier.segment_ids
      .map((id) => this.getSegment(id, { role, now: at }))
      .filter(Boolean);
    return {
      carrier_id: carrier.carrier_id,
      title: carrier.title,
      medium: carrier.medium,
      agreement_count: carrier.agreement_ids.length,
      segments,
    };
  }

  accessOf(segmentId, now) {
    return resolveAccess(this.state, segmentId, this._now(now));
  }

  speakerOf(segmentId, role = ROLES.PUBLIC) {
    return speakerView(this.state, segmentId, role);
  }
}
