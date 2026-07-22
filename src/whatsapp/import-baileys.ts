export type BaileysModule = typeof import('baileys');

// The application intentionally compiles to CommonJS, while Baileys 7 is
// ESM-only. TypeScript rewrites ordinary import() to require() in CommonJS,
// which would fail with ERR_REQUIRE_ESM. Keeping native import in this tiny,
// constant-only adapter preserves the existing backend module format.
const nativeImport = new Function(
  'specifier',
  'return import(specifier)'
) as (specifier: string) => Promise<BaileysModule>;

export function importBaileys(): Promise<BaileysModule> {
  return nativeImport('baileys');
}
