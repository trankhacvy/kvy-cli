import type { z } from "zod";

/**
 * A structural fingerprint of a zod schema: field names + primitive "kind"
 * per field, recursively. Used to freeze wire schemas in a checked-in
 * snapshot and detect the two changes the additive-only policy forbids:
 * a field disappearing, or a field's kind narrowing/changing shape
 * (design §5.3 — "additive-only, forever").
 */
export type ShapeDescriptor =
  | { kind: "object"; fields: Record<string, ShapeDescriptor> }
  | { kind: "union"; options: ShapeDescriptor[] }
  | { kind: "optional"; inner: ShapeDescriptor }
  | { kind: "nullable"; inner: ShapeDescriptor }
  | { kind: "array"; element: ShapeDescriptor }
  | { kind: "record"; key: ShapeDescriptor; value: ShapeDescriptor }
  | { kind: "literal"; values: unknown[] }
  | { kind: "enum"; options: string[] }
  | { kind: "leaf"; type: string };

// Zod v4 exposes `.def.type` publicly as a stable discriminator for schema
// introspection (the same mechanism zod-to-json-schema relies on) — no
// underscore-prefixed internals needed.
type IntrospectableSchema = z.ZodTypeAny & {
  def: { type: string; values?: Iterable<unknown> };
};

export function describeShape(schema: z.ZodTypeAny): ShapeDescriptor {
  const s = schema as IntrospectableSchema;
  const type = s.def.type;

  switch (type) {
    case "object": {
      const shape = (schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
      const fields: Record<string, ShapeDescriptor> = {};
      for (const key of Object.keys(shape).sort()) {
        fields[key] = describeShape(shape[key] as z.ZodTypeAny);
      }
      return { kind: "object", fields };
    }
    case "union": {
      const options = (schema as unknown as { options: z.ZodTypeAny[] }).options;
      return { kind: "union", options: options.map(describeShape) };
    }
    case "optional":
      return {
        kind: "optional",
        inner: describeShape((schema as unknown as { unwrap(): z.ZodTypeAny }).unwrap()),
      };
    case "nullable":
      return {
        kind: "nullable",
        inner: describeShape((schema as unknown as { unwrap(): z.ZodTypeAny }).unwrap()),
      };
    case "array":
      return {
        kind: "array",
        element: describeShape((schema as unknown as { element: z.ZodTypeAny }).element),
      };
    case "record": {
      const r = schema as unknown as { keyType: z.ZodTypeAny; valueType: z.ZodTypeAny };
      return { kind: "record", key: describeShape(r.keyType), value: describeShape(r.valueType) };
    }
    case "literal":
      return { kind: "literal", values: Array.from(s.def.values ?? []) };
    case "enum": {
      const options = (schema as unknown as { options: string[] }).options;
      return { kind: "enum", options: [...options].sort() };
    }
    default:
      return { kind: "leaf", type };
  }
}

/**
 * True if `next` is a backward-compatible evolution of `prev`: every field
 * `prev` requires is still present in `next` with a compatible (same-or-wider)
 * kind. New fields/options in `next` are ignored — additions never fail this
 * check, only removals and retypes do.
 */
export function isCompatible(prev: ShapeDescriptor, next: ShapeDescriptor): boolean {
  if (prev.kind !== next.kind) {
    // A field becoming optional (required -> optional) is a safe widening;
    // the reverse (optional -> required) falls through and fails below.
    if (next.kind === "optional") return isCompatible(prev, next.inner);
    return false;
  }

  switch (prev.kind) {
    case "object": {
      const n = next as Extract<ShapeDescriptor, { kind: "object" }>;
      return Object.keys(prev.fields).every((key) => {
        const nextField = n.fields[key];
        return nextField !== undefined && isCompatible(prev.fields[key]!, nextField);
      });
    }
    case "union": {
      const n = next as Extract<ShapeDescriptor, { kind: "union" }>;
      // Every previously-valid option must still be representable by some
      // current option — order/discriminator position doesn't matter.
      return prev.options.every((prevOpt) =>
        n.options.some((nextOpt) => isCompatible(prevOpt, nextOpt)),
      );
    }
    case "optional":
    case "nullable": {
      const n = next as Extract<ShapeDescriptor, { kind: "optional" | "nullable" }>;
      return isCompatible(prev.inner, n.inner);
    }
    case "array": {
      const n = next as Extract<ShapeDescriptor, { kind: "array" }>;
      return isCompatible(prev.element, n.element);
    }
    case "record": {
      const n = next as Extract<ShapeDescriptor, { kind: "record" }>;
      return isCompatible(prev.key, n.key) && isCompatible(prev.value, n.value);
    }
    case "literal": {
      const n = next as Extract<ShapeDescriptor, { kind: "literal" }>;
      return prev.values.every((v) => n.values.includes(v));
    }
    case "enum": {
      const n = next as Extract<ShapeDescriptor, { kind: "enum" }>;
      return prev.options.every((o) => n.options.includes(o));
    }
    case "leaf": {
      const n = next as Extract<ShapeDescriptor, { kind: "leaf" }>;
      return prev.type === n.type;
    }
  }
}
