// Counts characters for each Upwork portfolio field and checks Upwork's limits.
//   node docs/count-chars.mjs
import { readFileSync } from 'node:fs';

const f = JSON.parse(readFileSync(new URL('./portfolio-fields.json', import.meta.url), 'utf8'));
const check = (label, text, limit) => {
  const n = [...text].length;
  console.log(`${n <= limit ? 'OK  ' : 'OVER'} ${String(n).padStart(3)} / ${limit}  ${label}`);
  return n <= limit;
};
let ok = true;
f.titles.forEach((t, i) => (ok = check(`title ${i + 1}: ${t}`, t, 70) && ok));
ok = check('role', f.role, 100) && ok;
ok = check('description', f.description, 600) && ok;
console.log(`${f.skills.length === 5 ? 'OK  ' : 'OVER'} ${f.skills.length} skills (exactly 5): ${f.skills.join(', ')}`);
process.exit(ok && f.skills.length === 5 ? 0 : 1);
