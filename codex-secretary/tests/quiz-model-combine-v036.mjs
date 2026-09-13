import { readdir, readFile, writeFile } from 'node:fs/promises';

const directory = process.argv[2];
const output = process.argv[3];
if (!directory || !output) throw new Error('usage: node combine DIR OUTPUT');
const files = (await readdir(directory)).filter((file)=>file.endsWith('.json')).sort();
const rows = [];
for (const file of files) rows.push(...JSON.parse(await readFile(`${directory}/${file}`,'utf8')).rows);
if (files.length !== 12 || rows.length !== 120) throw new Error(`incomplete: files=${files.length} rows=${rows.length}`);
await writeFile(output,JSON.stringify({createdAt:new Date().toISOString(),files,rows},null,2));
console.log(JSON.stringify({files:files.length,rows:rows.length,output}));
