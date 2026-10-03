/**
 * 口述录音开放后端 HTTP 服务（node:http，零额外依赖）。
 *
 * 读路径（角色经 X-Role 头声明：public|researcher|editor|curator，默认 public；
 *         ?at=ISO-8601 可重放到指定时点）：
 *   GET  /v1/healthz
 *   GET  /v1/carriers/:carrierId
 *   GET  /v1/segments/:segmentId
 *   GET  /v1/segments/:segmentId/files
 *   GET  /v1/segments/:segmentId/history        版本与事件解释（editor+）
 *   GET  /v1/citations/:ref                     稳定引用解析（下架不 404）
 *   GET  /v1/search?q=&person=&year=&subject=
 *
 * 写路径（仅校订/馆员；命令产出领域事件并追加到事件流）：
 *   POST /v1/segments/:segmentId/notes                 editor+   校订意见（并存）
 *   POST /v1/segments/:segmentId/speaker-candidates    editor+   提出候选
 *   POST /v1/segments/:segmentId/speaker-resolution    curator   认定/撤销认定
 *   POST /v1/segments/:segmentId/transcript            editor    初录
 *   POST /v1/segments/:segmentId/transcript/corrections editor+  校订（旧版保留）
 *   POST /v1/segments/:segmentId/song-rights           curator   歌曲权利
 *   POST /v1/segments/:segmentId/decisions             curator   开放/遮蔽/暂缓
 *   POST /v1/segments/:segmentId/withdrawals           curator   临时下架
 *   POST /v1/segments/:segmentId/restorations          curator   恢复开放
 */
import { createServer } from "node:http";
import { EventStore, ConcurrencyError } from "../domain/event-store.js";
import { CatalogService, ValidationFailure } from "../domain/catalog-service.js";
import { CatalogQuery, queryFromService } from "../access/catalog-query.js";
import { ROLES, roleAtLeast, accessibleFiles } from "../access/access-policy.js";
import { parseCitation } from "../access/citations.js";

const JSON_TYPE = "application/json; charset=utf-8";

export function createApp({ service, storeFile = null } = {}) {
  const svc = service ?? new CatalogService(new EventStore());

  function queryFor(at) {
    return at ? queryFromService(svc, { asOf: at }) : new CatalogQuery(svc.state);
  }

  async function persist() {
    if (storeFile) await svc.store.saveToFile(storeFile);
  }

  return createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": JSON_TYPE });
      res.end(JSON.stringify(body));
    };
    try {
      await route(req, res, send);
    } catch (err) {
      if (err instanceof ValidationFailure) {
        send(400, { error: "validation_failed", reasons: err.errors });
      } else if (err instanceof ConcurrencyError) {
        send(409, { error: "version_conflict", expected: err.expected, actual: err.actual });
      } else if (err.statusCode === 403) {
        send(403, { error: "forbidden" });
      } else {
        send(500, { error: "internal_error", message: err.message });
      }
    }
  });

  async function route(req, res, send) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;
    const role = roleFromHeader(req.headers["x-role"]);
    const at = url.searchParams.get("at");

    if (method === "GET" && path === "/v1/healthz") {
      return send(200, { ok: true, events: svc.store.all().length });
    }

    let m;
    if (method === "GET" && (m = /^\/v1\/carriers\/([^/]+)$/.exec(path))) {
      const view = queryFor(at).listCarrier(decodeURIComponent(m[1]), { role });
      return view ? send(200, view) : send(404, { error: "not_found" });
    }

    if (method === "GET" && (m = /^\/v1\/segments\/([^/]+)$/.exec(path))) {
      const view = queryFor(at).getSegment(decodeURIComponent(m[1]), { role });
      return view ? send(200, view) : send(404, { error: "not_found" });
    }

    if (method === "GET" && (m = /^\/v1\/segments\/([^/]+)\/files$/.exec(path))) {
      const segmentId = decodeURIComponent(m[1]);
      const state = queryFor(at).state;
      if (!state.segments.has(segmentId)) return send(404, { error: "not_found" });
      return send(200, { segment_id: segmentId, files: accessibleFiles(state, segmentId, { role, now: at }) });
    }

    if (method === "GET" && (m = /^\/v1\/segments\/([^/]+)\/history$/.exec(path))) {
      if (!roleAtLeast(role, ROLES.EDITOR)) return send(403, { error: "forbidden" });
      const state = queryFor(at).state;
      const segmentId = decodeURIComponent(m[1]);
      const events = state.timeline.filter((e) =>
        e.payload?.segment_id === segmentId ||
        (e.aggregate_type === "audio_segment" && e.aggregate_id === segmentId),
      );
      return send(200, {
        segment_id: segmentId,
        events: events.map((e) => ({
          event_id: e.event_id,
          event_type: e.event_type,
          aggregate_type: e.aggregate_type,
          aggregate_id: e.aggregate_id,
          version: e.version,
          occurred_at: e.occurred_at,
          actor: e.actor?.name ?? null,
          summary: e.summary,
        })),
      });
    }

    if (method === "GET" && path.startsWith("/v1/citations/")) {
      const ref = decodeURIComponent(path.slice("/v1/citations/".length));
      if (!parseCitation(ref)) return send(400, { error: "bad_citation" });
      return send(200, queryFor(at).resolve(ref, { role }));
    }

    if (method === "GET" && path === "/v1/search") {
      const results = queryFor(at).search({
        q: url.searchParams.get("q") ?? undefined,
        person: url.searchParams.get("person") ?? undefined,
        year: url.searchParams.get("year") ?? undefined,
        subject: url.searchParams.get("subject") ?? undefined,
      });
      return send(200, { count: results.length, results });
    }

    // ---------- 写路径 ----------
    const writeMatch = method === "POST" && /^\/v1\/segments\/([^/]+)(\/.+)?$/.exec(path);
    if (writeMatch) {
      const segmentId = decodeURIComponent(writeMatch[1]);
      const action = writeMatch[2] ?? "";
      const body = await readJson(req);
      const actor = { id: req.headers["x-user-id"] ?? "anon", name: req.headers["x-user-name"] ?? role, role };
      const cmd = { ...body, segment_id: segmentId, actor };

      const requireRole = (min) => {
        if (!roleAtLeast(role, min)) {
          const err = new Error("forbidden");
          err.statusCode = 403;
          throw err;
        }
      };

      let produced;
      switch (action) {
        case "/notes":
          requireRole(ROLES.EDITOR);
          produced = [svc.addReviewNote(cmd)];
          break;
        case "/speaker-candidates":
          requireRole(ROLES.EDITOR);
          produced = [svc.proposeSpeakerCandidate(cmd)];
          break;
        case "/speaker-resolution":
          requireRole(ROLES.CURATOR);
          produced = [svc.resolveSpeaker(cmd)];
          break;
        case "/transcript":
          requireRole(ROLES.EDITOR);
          produced = [svc.recordTranscript(cmd)];
          break;
        case "/transcript/corrections":
          requireRole(ROLES.EDITOR);
          produced = [svc.correctTranscript(cmd)];
          break;
        case "/song-rights":
          requireRole(ROLES.CURATOR);
          produced = [svc.recordSongRights(cmd)];
          break;
        case "/decisions":
          requireRole(ROLES.CURATOR);
          produced = [svc.decideRelease(cmd)];
          break;
        case "/withdrawals":
          requireRole(ROLES.CURATOR);
          produced = [svc.withdrawSegment(cmd)];
          break;
        case "/restorations":
          requireRole(ROLES.CURATOR);
          produced = [svc.restoreSegment(cmd)];
          break;
        default:
          return send(404, { error: "unknown_action" });
      }
      await persist();
      return send(201, { accepted: true, events: produced.map(publicEvent) });
    }

    return send(404, { error: "not_found" });
  }
}

function roleFromHeader(value) {
  const v = String(value ?? "public").toLowerCase();
  return [ROLES.PUBLIC, ROLES.RESEARCHER, ROLES.EDITOR, ROLES.CURATOR].includes(v)
    ? v
    : ROLES.PUBLIC;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("payload_too_large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ValidationFailure("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function publicEvent(e) {
  return {
    event_id: e.event_id,
    event_type: e.event_type,
    aggregate_type: e.aggregate_type,
    aggregate_id: e.aggregate_id,
    version: e.version,
    occurred_at: e.occurred_at,
  };
}

export async function startServer({ port = 8080, storeFile = null, seed = null } = {}) {
  const store = new EventStore();
  if (storeFile) {
    try {
      await store.loadFromFile(storeFile);
    } catch {
      if (seed) seed(new CatalogService(store));
      await store.saveToFile(storeFile);
    }
  } else if (seed) {
    seed(new CatalogService(store));
  }
  const service = new CatalogService(store);
  const app = createApp({ service, storeFile });
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve({ server, service, port }));
  });
}
