/**
 * JSON Schema の実行時検証 (指示書 §6-5, §7-3)。
 *
 * 依存を増やさないため、本システムが実際に使う部分集合だけを実装する:
 *   type / properties / required / additionalProperties / items / enum /
 *   minimum / maximum / minLength / nullable(type 配列)
 *
 * 未対応キーワードは「検証しない」であり「合格にする」ではない。
 * スキーマ側で未対応キーワードに頼らないこと。
 */

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value; // string | number | boolean | object | undefined
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  return actual === expected;
}

function validateNode(value, schema, pathText, errors) {
  if (!schema || typeof schema !== "object") return;

  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expectedTypes.some((t) => typeMatches(value, t))) {
      errors.push(`${pathText}: 型が ${expectedTypes.join("|")} ではありません (実際: ${typeOf(value)})`);
      return; // 型が違う時点で以降の検査は無意味
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${pathText}: ${JSON.stringify(value)} は許可された値ではありません (${schema.enum.join(", ")})`);
  }

  if (typeof value === "string") {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${pathText}: ${schema.minLength} 文字以上である必要があります`);
    }
  }

  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push(`${pathText}: ${schema.minimum} 以上である必要があります`);
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push(`${pathText}: ${schema.maximum} 以下である必要があります`);
    }
  }

  if (typeOf(value) === "array" && schema.items) {
    value.forEach((item, i) => validateNode(item, schema.items, `${pathText}[${i}]`, errors));
  }

  if (typeOf(value) === "object" && (schema.properties || schema.required)) {
    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === undefined) {
        errors.push(`${pathText}.${key}: 必須項目がありません`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value && value[key] !== undefined) {
        validateNode(value[key], sub, `${pathText}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${pathText}.${key}: 未知のプロパティです`);
      }
    }
  }
}

export function validate(value, schema) {
  const errors = [];
  validateNode(value, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}
