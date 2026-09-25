import assert from "node:assert/strict";
import { test } from "node:test";
import {
  argsSha256,
  canonicalJson,
  compareCodePoints,
  JsonNumber,
  parseJsonLossless,
  pyFloatRepr,
  sha256Hex,
  toPlain,
} from "../src/canonical.ts";

const VECTOR_INPUT =
  '{"title":"fix(ordinal): 12th","owner":"vishnuverse","repo":"humanize","body":"Café ✓ — evidence","head":"fix/issue-1","base":"main","n":[3,1],"nested":{"z":1,"a":true,"m":null}}';
const VECTOR_CANONICAL =
  '{"base":"main","body":"Café ✓ — evidence","head":"fix/issue-1","n":[3,1],"nested":{"a":true,"m":null,"z":1},"owner":"vishnuverse","repo":"humanize","title":"fix(ordinal): 12th"}';
const VECTOR_SHA = "fb4b7e1382b28cbd8d0789701b5a0ee69efec57b9d487c5fbcc84abef0ce27f4";

test("contract vector: canonical form and sha256 (JSON.parse input)", () => {
  const v = JSON.parse(VECTOR_INPUT) as unknown;
  assert.equal(canonicalJson(v), VECTOR_CANONICAL);
  assert.equal(argsSha256(v), VECTOR_SHA);
});

test("contract vector: same result through the lossless parser", () => {
  const v = parseJsonLossless(VECTOR_INPUT);
  assert.equal(canonicalJson(v), VECTOR_CANONICAL);
  assert.equal(argsSha256(v), VECTOR_SHA);
});

test("python parity: floats, ints, escapes and code-point key order", () => {
  // Expected values produced by:
  // json.dumps(json.loads(TXT), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
  const txt =
    '{"f":[1.0,1.5,-0.0,0,-0,1e16,1e15,123456789012345678901234567890,0.0001,0.00001,1e-7,2.5e-300,1.7976931348623157e308,100.0,1E2,0.1,12345.678,5e-324,1e22,1e21,123456789.123],"s":"a\\"b\\\\c\\n\\t\\u0001\\u001f\\u007f\\u2028 \\ud83d\\ude00 é","\\ud83d\\ude00":1,"\\uffff":2,"z":3,"B":4,"a":5}';
  const expected =
    '{"B":4,"a":5,"f":[1.0,1.5,-0.0,0,0,1e+16,1000000000000000.0,123456789012345678901234567890,0.0001,1e-05,1e-07,2.5e-300,1.7976931348623157e+308,100.0,100.0,0.1,12345.678,5e-324,1e+22,1e+21,123456789.123],"s":"a\\"b\\\\c\\n\\t\\u0001\\u001f\u007f\u2028 😀 é","z":3,"\uffff":2,"😀":1}';
  const out = canonicalJson(parseJsonLossless(txt));
  assert.equal(out, expected);
  assert.equal(sha256Hex(out), "c21bc6b9ccc1b521cfb4d4a40786b4bab6768052b69d7c8df358afa474bcb21e");
});

test("pyFloatRepr matches Python repr()", () => {
  const cases: [number, string][] = [
    [1, "1.0"],
    [0.1, "0.1"],
    [-2.5, "-2.5"],
    [1e16, "1e+16"],
    [1e15, "1000000000000000.0"],
    [1e-5, "1e-05"],
    [1e-4, "0.0001"],
    [123.456, "123.456"],
    [-0, "-0.0"],
    [0, "0.0"],
    [Infinity, "Infinity"],
  ];
  for (const [x, want] of cases) assert.equal(pyFloatRepr(x), want, String(x));
});

test("plain JS numbers: integers print as ints, others as Python floats", () => {
  assert.equal(canonicalJson({ a: 1, b: 1.5, c: 1e21, d: -0 }), '{"a":1,"b":1.5,"c":1000000000000000000000,"d":-0.0}');
});

test("key order is by code point, not UTF-16 unit", () => {
  assert.ok(compareCodePoints("\uffff", "😀") < 0);
  assert.ok(["😀", "\uffff"].sort()[0] === "😀"); // JS default differs, hence compareCodePoints
  assert.equal(canonicalJson({ "😀": 1, "\uffff": 2 }), '{"\uffff":2,"😀":1}');
});

test("lossless parser keeps int/float kind and odd keys", () => {
  const v = parseJsonLossless('{"__proto__":{"x":1.0},"n":10,"big":12345678901234567890}') as Record<string, unknown>;
  assert.ok(Object.prototype.hasOwnProperty.call(v, "__proto__"));
  assert.equal(canonicalJson(v), '{"__proto__":{"x":1.0},"big":12345678901234567890,"n":10}');
  const n = v.n as JsonNumber;
  assert.ok(n instanceof JsonNumber && n.isInt);
  assert.deepEqual(toPlain(parseJsonLossless('{"a":[1.5,2]}')), { a: [1.5, 2] });
  assert.throws(() => parseJsonLossless('{"a":1,}'), SyntaxError);
  assert.throws(() => parseJsonLossless("[1] x"), SyntaxError);
});

test("empty input hashes as {}", () => {
  assert.equal(argsSha256({}), sha256Hex("{}"));
});
