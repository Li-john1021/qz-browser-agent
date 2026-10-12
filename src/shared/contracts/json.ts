/** JSON builders own mutable values; public snapshots can also accept deeply readonly input. */
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type ReadonlyJsonValue = null | string | number | boolean | readonly ReadonlyJsonValue[] | { readonly [key: string]: ReadonlyJsonValue };
