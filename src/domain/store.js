// 事件存储：仅追加。事件一经写入不可修改、不可删除；版本变化通过追加新事件表达。
// 每个聚合拥有独立事件流，version 在流内从 1 递增；event_id 全局唯一且永不复用。

export class EventStore {
  constructor() {
    /** @type {Array<object>} 全局事件日志，按写入顺序排列 */
    this.log = [];
    /** @type {Map<string, number>} 流键 -> 期望版本（乐观并发） */
    this.streamVersions = new Map();
    this.eventIds = new Set();
  }

  static streamKey(aggregateType, aggregateId) {
    return `${aggregateType}:${aggregateId}`;
  }

  /**
   * @param {object} event 已通过信封校验的事件
   * @param {number} [expectedVersion] 该流当前应处版本；缺省则不检查
   */
  append(event, expectedVersion) {
    if (this.eventIds.has(event.event_id)) {
      throw new Error(`event_id 已存在，禁止复用：${event.event_id}`);
    }
    const key = EventStore.streamKey(event.aggregate_type, event.aggregate_id);
    const current = this.streamVersions.get(key) ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== current) {
      throw new Error(
        `并发冲突：流 ${key} 版本 ${current} 与期望 ${expectedVersion} 不一致`,
      );
    }
    if (event.version !== current + 1) {
      throw new Error(
        `版本不连续：流 ${key} 下一版本应为 ${current + 1}，收到 ${event.version}`,
      );
    }
    const stored = { ...event, seq: this.log.length };
    this.log.push(stored);
    this.eventIds.add(event.event_id);
    this.streamVersions.set(key, event.version);
    return stored;
  }

  eventsFor(aggregateType, aggregateId) {
    const prefix = EventStore.streamKey(aggregateType, aggregateId) + ":";
    return this.log.filter(
      (e) => EventStore.streamKey(e.aggregate_type, e.aggregate_id) + ":" === prefix,
    );
  }

  eventsByType(type) {
    return this.log.filter((e) => e.event_type === type);
  }

  getEvent(eventId) {
    return this.log.find((e) => e.event_id === eventId) ?? null;
  }

  versionOf(aggregateType, aggregateId) {
    return this.streamVersions.get(EventStore.streamKey(aggregateType, aggregateId)) ?? 0;
  }
}
