import { build } from 'esbuild';

const shared = {
  bundle: true,
  sourcemap: true,
  target: 'chrome120',
  format: 'esm',
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ['src/background.ts'],
    outfile: 'dist/background.js',
  }),
  build({
    ...shared,
    entryPoints: ['src/popup.ts'],
    outfile: 'dist/popup.js',
  }),
]);

console.log('Extension built successfully');
