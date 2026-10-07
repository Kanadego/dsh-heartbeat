import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: true,
  // H-83: the package ships types; tsup emits them from the same entries.
  // `resolve` inlines types from other packages — without it the generated
  // declaration for `Config` references pnpm's `.pnpm/...` store path and
  // tsc rejects it as non-portable (TS2742).
  dts: { resolve: true },
});
