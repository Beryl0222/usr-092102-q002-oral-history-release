/**
 * EventStore：事件溯源存储。
 *
 * - append 以聚合流（aggregate_type/aggregate_id）为单位分配递增 version；
 * - expectedVersion 提供乐观并发控制；
 * - 事件只追加、不可修改；任何“修正”都是新事件 + 新版本，旧版本仍可解释。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export class ConcurrencyError extends Error {
  constructor(aggregateId, expected, actual) {
    super(`聚合 ${aggregateId} 版本冲突：期望 ${expected}，当前 ${actual}`);
    this.name = "ConcurrencyError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class EventStore {
  constructor() {
    /** @type {Array<import('./events.js').DomainEvent>} */
    this.events = [];
    /** @type {Map<string, number>} streamKey -> 当前版本 */
    this.streamVersions = new Map();
    /** @type {Set<string>} 已用 event_id，防重放 */
    this.eventIds = new Set();
  }

  static streamKey(event) {
    return `${event.aggregate_type}/${event.aggregate_id}`;
  }

  /**
   * 追加一批事件（同一命令可产生多个聚合流上的事件）。
   * @param {object[]} newEvents
   * @param {{expectedVersions?: Map<string, number>}} [options]
   *        expectedVersions 以 streamKey（aggregate_type/aggregate_id）为键做乐观并发控制。
   */
  append(newEvents, options = {}) {
    const committed = [];
    for (const raw of newEvents) {
      const key = EventStore.streamKey(raw);
      const current = this.streamVersions.get(key) ?? 0;
      const expected = options.expectedVersions?.get(key);
      if (expected !== undefined && expected !== current) {
        throw new ConcurrencyError(raw.aggregate_id, expected, current);
      }
      if (this.eventIds.has(raw.event_id)) {
        throw new Error(`event_id 重复：${raw.event_id}`);
      }
      const next = current + 1;
      const event = { ...raw, version: next };
      this.streamVersions.set(key, next);
      this.eventIds.add(event.event_id);
      this.events.push(event);
      committed.push(event);
    }
    return committed;
  }

  all() {
    return [...this.events];
  }

  byAggregate(aggregateType, aggregateId) {
    return this.events.filter(
      (e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId,
    );
  }

  /** 从持久化 JSONL 载入（事件按行存储）。 */
  async loadFromFile(path) {
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    const loaded = lines.map((line) => JSON.parse(line));
    this.append(loaded.map((e) => ({ ...e, version: 0 })));
  }

  async saveToFile(path) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${this.events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  }
}
