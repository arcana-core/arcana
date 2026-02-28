import { loadArcanaPlugins } from '../src/plugin-loader.js';
const x = await loadArcanaPlugins(process.cwd());
console.log(JSON.stringify({ files: x.pluginFiles, tools: x.tools.map(t=>t.name) }, null, 2));
