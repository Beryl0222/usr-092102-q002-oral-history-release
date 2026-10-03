/**
 * 领域事件信封基础校验。
 *
 * 仅依赖 contracts/domain.schema.json 中登记的标识集合，保证各参与方
 * 对 event_type / aggregate_type 的理解一致；payload 内业务字段由
 * catalog-service 的不变量检查负责。
 */
import { readFile } from "node:fs/promises";

const REQUIRED = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

let schemaCache;
async function loadSchema() {
  if (!schemaCache) {
    schemaCache = JSON.parse(
      await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"),
    );
  }
  return schemaCache;
}

/** 不读 schema 的轻量校验：供热路径与既有调用方使用。 */
export function validateEvent(record) {
  const errors = REQUIRED.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  return errors;
}

/** 对照 contracts/domain.schema.json 的完整枚举校验。 */
export async function validateEventAgainstContract(record) {
  const schema = await loadSchema();
  const errors = validateEvent(record);
  if (errors.length) return errors;

  if (!schema.properties.event_type.enum.includes(record.event_type)) {
    errors.push(`event_type 未在契约登记：${record.event_type}`);
  }
  if (!schema.properties.aggregate_type.enum.includes(record.aggregate_type)) {
    errors.push(`aggregate_type 未在契约登记：${record.aggregate_type}`);
  }
  if (typeof record.event_id !== "string" || !record.event_id.trim()) {
    errors.push("event_id 必须是非空字符串");
  }
  if (typeof record.aggregate_id !== "string" || !record.aggregate_id.trim()) {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if (Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法的 date-time");
  }
  if (typeof record.summary !== "string" || !record.summary.trim()) {
    errors.push("summary 必须是非空字符串");
  }

  const payload = record.payload ?? {};
  if (payload.basis !== undefined && !schema.$defs.basis.enum.includes(payload.basis)) {
    errors.push(`payload.basis 不在契约枚举内：${payload.basis}`);
  }
  if (payload.action !== undefined && !schema.$defs.access_action.enum.includes(payload.action)) {
    errors.push(`payload.action 不在契约枚举内：${payload.action}`);
  }
  if (payload.role !== undefined && !schema.$defs.file_role.enum.includes(payload.role)) {
    errors.push(`payload.role 不在契约枚举内：${payload.role}`);
  }
  return errors;
}
