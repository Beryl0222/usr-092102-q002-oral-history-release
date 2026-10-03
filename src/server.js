// 口述录音开放后端 HTTP 入口。
// 身份：内部可信头 x-user-id / x-user-role（演示与联调用；生产应置于网关鉴权之后）。
// 所有写入经 OralHistoryService 走事件不变量；所有读取经 Catalog/policy 做授权过滤。

import { createServer } from "node:http";

import { OralHistoryService, DomainError } from "./domain/commands.js";
import { Catalog } from "./catalog/projector.js";
import { citationRef } from "./domain/identifiers.js";

const STAFF = new Set(["cataloger", "reviewer", "rights_officer", "release_officer", "admin"]);

function viewerFrom(req) {
  const role = req.headers["x-user-role"];
  const id = req.headers["x-user-id"];
  if (role && STAFF.has(role) && id) return { id: String(id), role: String(role) };
  return { id: null, role: "public" };
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
};

const readBody = (req, limit = 1_000_000) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });

export function createApp(service = new OralHistoryService()) {
  const catalog = () => new Catalog(service.state());

  return async function app(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = decodeURIComponent(url.pathname);
    const viewer = viewerFrom(req);
    try {
      // ---------- 读者侧 ----------
      if (req.method === "GET" && path === "/healthz") {
        return json(res, 200, { ok: true, events: service.store.log.length });
      }

      if (req.method === "GET" && path === "/search") {
        const result = catalog().search(
          {
            q: url.searchParams.get("q") ?? undefined,
            person_id: url.searchParams.get("person_id") ?? undefined,
            topic: url.searchParams.get("topic") ?? undefined,
            year: url.searchParams.get("year") ? Number(url.searchParams.get("year")) : undefined,
            from: url.searchParams.get("from") ?? undefined,
            to: url.searchParams.get("to") ?? undefined,
          },
          viewer,
        );
        return json(res, 200, result);
      }

      if (req.method === "GET" && path.startsWith("/citations/")) {
        const ref = path.slice("/citations/".length);
        const result = catalog().resolveCitation(ref, viewer);
        const status =
          result.status === "resolved"
            ? 200
            : result.status === "malformed"
              ? 400
              : 404;
        return json(res, status, result);
      }

      if (req.method === "GET" && path.startsWith("/carriers/")) {
        const id = path.slice("/carriers/".length);
        const result = catalog().describeCarrier(id, viewer);
        return json(res, result.status === "resolved" ? 200 : result.status === "forbidden" ? 403 : 404, result);
      }

      const segMatch = /^\/segments\/([^/]+)(?:\/(audio|transcript))?$/.exec(path);
      if (req.method === "GET" && segMatch) {
        const [, segmentId, part] = segMatch;
        const access = catalog().segmentAccess(segmentId, viewer);
        if (access.status === "not_found") return json(res, 404, { error: "片段不存在", segment_id: segmentId });
        if (part === "audio") {
          if (access.status === "withdrawn") {
            return json(res, 410, {
              error: "该片段临时下架，音频窗口及其衍生文件暂停访问",
              segment_id: segmentId,
              withdrawal: access.withdrawal,
            });
          }
          if (access.audio.mode === "none") {
            return json(res, 403, { error: "该片段未开放音频", status: access.status, reasons: access.withheld_reasons });
          }
          // 下架时不返回任何衍生文件——access 已保证；此处再次显式裁剪
          if (access.status === "withdrawn") return json(res, 410, { error: "已下架" });
          return json(res, 200, {
            segment_id: segmentId,
            mode: access.audio.mode,
            assets: access.audio.assets,
            muted_ranges: access.audio.muted_ranges ?? [],
            time_range: access.time_range,
            channel: access.channel,
          });
        }
        if (part === "transcript") {
          if (access.status === "withdrawn") {
            return json(res, 410, { error: "该片段临时下架", withdrawal: access.withdrawal });
          }
          if (access.transcript?.mode === "none" || access.status === "withheld") {
            return json(res, 403, { error: "该片段文字未开放", status: access.status });
          }
          const ref = catalog()
            .resolveCitation(
              citationRef(segmentId, access.carrier_id, access.transcript.version),
              viewer,
            );
          return json(res, 200, {
            segment_id: segmentId,
            transcript: access.transcript,
            speaker: access.speaker,
            citation: ref.canonical_ref,
            superseded: ref.superseded,
          });
        }
        return json(res, 200, access);
      }

      // ---------- 馆员侧 ----------
      if (req.method === "POST" && path === "/events") {
        if (!STAFF.has(viewer.role)) return json(res, 401, { error: "需要馆员身份（x-user-id / x-user-role）" });
        const body = await readBody(req);
        const list = Array.isArray(body) ? body : [body];
        const appended = [];
        try {
          for (const ev of list) {
            const withActor = { ...ev, actor: { ...(ev.actor ?? {}), id: viewer.id, role: viewer.role } };
            appended.push(service.appendRawEvent(withActor));
          }
        } catch (err) {
          if (err instanceof DomainError) {
            // 批量摄入：失败时报告已写入条数，调用方可据此续传（事件存储不回滚已确认事实）
            return json(res, 422, { error: err.message, appended: appended.length });
          }
          throw err;
        }
        return json(res, 201, { appended: appended.map((e) => e.event_id) });
      }

      const actionMatch = /^\/segments\/([^/]+)\/(withdraw|restore)$/.exec(path);
      if (req.method === "POST" && actionMatch) {
        const [, segmentId, action] = actionMatch;
        if (!STAFF.has(viewer.role)) return json(res, 401, { error: "需要馆员身份" });
        const body = (await readBody(req)) ?? {};
        try {
          const ev =
            action === "withdraw"
              ? service.withdrawSegment(viewer, segmentId, {
                  reason: body.reason,
                  basis_refs: body.basis_refs ?? [],
                  expected_restore_after: body.expected_restore_after ?? null,
                })
              : service.restoreSegment(viewer, segmentId, body.note ?? "");
          return json(res, 201, { event_id: ev.event_id, segment_id: segmentId, action });
        } catch (err) {
          if (err instanceof DomainError) return json(res, 422, { error: err.message });
          throw err;
        }
      }

      // ---------- 事件流审计（馆员） ----------
      if (req.method === "GET" && path === "/events") {
        if (!STAFF.has(viewer.role)) return json(res, 401, { error: "需要馆员身份" });
        return json(res, 200, { count: service.store.log.length, events: service.store.log });
      }

      return json(res, 404, { error: "未找到对应资源", path });
    } catch (err) {
      if (err instanceof DomainError) return json(res, 422, { error: err.message });
      return json(res, 500, { error: "服务器内部错误", detail: String(err?.message ?? err) });
    }
  };
}

export function start(service = new OralHistoryService(), port = Number(process.env.PORT ?? 3000)) {
  const server = createServer(createApp(service));
  server.listen(port, () => {
    console.log(`抗联录音开放后端已启动：http://localhost:${port}`);
  });
  return server;
}
