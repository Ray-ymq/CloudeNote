import esbuild from 'esbuild';
const options = {
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian', 'electron'],
  platform: 'node', target: 'es2022', format: 'cjs', outfile: 'dist/main.js',
  sourcemap: false, logLevel: 'info'
};
if (process.argv.includes('--watch')) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
