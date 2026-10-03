import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const schema = require("../contracts/domain.schema.json");

const required = schema.required;
const eventTypes = new Set(schema.properties.event_type.enum);
const aggregateTypes = new Set(schema.properties.aggregate_type.enum);

const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 校验领域事件信封。仅做格式与枚举检查；业务不变量由 domain/commands.js 负责。
 * 返回中文错误信息数组，空数组表示通过。
 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => record == null || !(name in record))
    .map((name) => `缺少字段：${name}`);
  if (record == null || typeof record !== "object") return errors;

  if (typeof record.event_id !== "string" || record.event_id.length === 0) {
    errors.push("event_id 必须是非空字符串");
  }
  if (!eventTypes.has(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if (!aggregateTypes.has(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0) {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if (typeof record.occurred_at !== "string" || !isoDateTime.test(record.occurred_at)) {
    errors.push("occurred_at 必须是 ISO 8601 日期时间");
  }
  if (!Number.isInteger(record.version) || record.version < 1) {
    errors.push("version 必须是正整数");
  }
  if (typeof record.summary !== "string" || record.summary.length === 0) {
    errors.push("summary 必须是非空字符串");
  }
  if ("actor" in record) {
    if (typeof record.actor !== "object" || record.actor === null) {
      errors.push("actor 必须是对象");
    } else if (typeof record.actor.id !== "string" || typeof record.actor.role !== "string") {
      errors.push("actor 必须包含 id 与 role");
    }
  }
  return errors;
}

export const EVENT_TYPES = schema.properties.event_type.enum;
export const AGGREGATE_TYPES = schema.properties.aggregate_type.enum;
