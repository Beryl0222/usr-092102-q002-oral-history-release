// 稳定标识约定：所有 id 均为业务可读字符串，永不因修订而改变。
// 逐字稿修订流与开放决定流以片段 id 派生，保证一个时间片段的各维度可单独控制。

export function transcriptStreamId(segmentId) {
  return `tr-${segmentId}`;
}

export function decisionId(segmentId) {
  return `rd-${segmentId}`;
}

export function reviewNoteId(segmentId, n) {
  return `rn-${segmentId}-${String(n).padStart(3, "0")}`;
}

/** 稳定引用：nlc-oh/<磁带>/<片段>[@<逐字稿版本>]；不附版本即指向当前版 */
export function citationRef(segmentId, carrierId, transcriptVersion) {
  const base = `nlc-oh/${carrierId}/${segmentId}`;
  return transcriptVersion ? `${base}@v${transcriptVersion}` : base;
}

export function nowIso(now = new Date()) {
  return now.toISOString();
}
