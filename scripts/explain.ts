// Ask a plain-English question about recent failures.
//   npm run explain -- "Why did the welcome emails fail last night?"
import { api } from './api.js';

const question = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim() || 'Why did the welcome emails fail last night?';
const { answer, model } = await api<{ answer: string; model: string }>('/api/ask', { method: 'POST', body: JSON.stringify({ question }) });
console.log(answer);
console.log(`\n(${model}. Claude reads masked logs only and cannot change settings.)`);
