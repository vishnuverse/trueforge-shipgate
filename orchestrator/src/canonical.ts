// Canonical JSON + args_sha256 (docs/contracts.md §3).
//
// Must match Python byte for byte:
//   json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
// Python keeps the int/float distinction from the JSON text (1.0 stays "1.0"), so tool arguments are parsed with
// a small lossless parser that remembers whether each number was written as an int or a float.
import { createHash } from "node:crypto";

/** A number as written in JSON text: `isInt` = no fraction and no exponent (Python `int`), else Python `float`. */
export class JsonNumber {
  constructor(
    readonly raw: string,
    readonly isInt: boolean,
  ) {}
  toJSON(): number {
    return Number(this.raw);
  }
}

export type JsonValue = null | boolean | string | number | JsonNumber | JsonValue[] | { [key: string]: JsonValue };

/** Parse JSON text keeping each number's int/float kind (see JsonNumber). Throws SyntaxError on bad input. */
export function parseJsonLossless(text: string): JsonValue {
  let i = 0;
  const fail = (msg: string): never => {
    throw new SyntaxError(`${msg} at position ${i}`);
  };
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const parseString = (): string => {
    // text[i] === '"'
    i++;
    let out = "";
    let start = i;
    while (true) {
      if (i >= text.length) fail("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c === 0x5c) {
        out += text.slice(start, i);
        i++;
        const e = text[i];
        i++;
        switch (e) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail("bad escape");
        }
        start = i;
        continue;
      }
      if (c < 0x20) fail("control character in string");
      i++;
    }
  };
  const parseNumber = (): JsonNumber => {
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) return fail("bad number");
    i += m[0].length;
    return new JsonNumber(m[0], m[1] === undefined && m[2] === undefined);
  };
  const parseValue = (): JsonValue => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: { [key: string]: JsonValue } = {};
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      while (true) {
        ws();
        if (text[i] !== '"') fail("expected key");
        const key = parseString();
        ws();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        const val = parseValue();
        Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: JsonValue[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      while (true) {
        arr.push(parseValue());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return parseString();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return parseNumber();
    return fail("unexpected token");
  };
  const v = parseValue();
  ws();
  if (i !== text.length) fail("trailing data");
  return v;
}

/** Convert lossless values to plain JS values (JsonNumber -> number) for display. */
export function toPlain(v: unknown): unknown {
  if (v instanceof JsonNumber) return Number(v.raw);
  if (Array.isArray(v)) return v.map(toPlain);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      Object.defineProperty(out, k, { value: toPlain(x), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

/** Python's key order: compare by Unicode code point (JS default sort compares UTF-16 code units). */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let k = 0; k < n; k++) {
    const d = (x[k] as string).codePointAt(0)! - (y[k] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Python json string encoding with ensure_ascii=False. */
export function pyJsonString(s: string): string {
  let out = '"';
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x0c:
        out += "\\f";
        break;
      default:
        out += c < 0x20 ? "\\u" + c.toString(16).padStart(4, "0") : s[k];
    }
  }
  return out + '"';
}

/** Python repr(float): shortest round-trip digits, exponent form when decpt <= -4 or decpt > 16. */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant, exp] = Math.abs(x).toExponential().split("e") as [string, string];
  const digits = mant.replace(".", "");
  const decpt = parseInt(exp, 10) + 1;
  if (decpt <= -4 || decpt > 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = decpt - 1;
    return `${sign}${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

function pyNumber(n: number | JsonNumber): string {
  if (n instanceof JsonNumber) {
    if (n.isInt) return BigInt(n.raw).toString(); // "-0" -> "0", big ints exact
    return pyFloatRepr(Number(n.raw));
  }
  if (Number.isInteger(n) && !Object.is(n, -0)) return BigInt(n).toString();
  return pyFloatRepr(n);
}

/** Canonical serialisation (sorted keys, no spaces, UTF-8 kept). */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") return pyJsonString(v);
  if (typeof v === "number" || v instanceof JsonNumber) return pyNumber(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort(compareCodePoints);
    const obj = v as Record<string, unknown>;
    return `{${keys.map((k) => `${pyJsonString(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  throw new TypeError(`cannot canonicalise ${typeof v}`);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

/** SHA-256 hex of the canonical JSON of an MCP tool input. */
export function argsSha256(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}
