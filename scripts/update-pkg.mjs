import fs from "node:fs";
const p="arcana/package.json";
const j=JSON.parse(fs.readFileSync(p,"utf8"));
j.scripts=j.scripts||{};
j.scripts["web:serve"]="node ./bin/arcana.js gateway serve";
fs.writeFileSync(p, JSON.stringify(j,null,2));
