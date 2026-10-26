import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { useRealClaude } from './config.js';
import { scrub } from './mask.js';

// Claude's only job here is to read and explain. It gets text in and returns text out:
// no tools, no access to settings, no way to replay anything.

export interface Explanation {
  summary: string;
  likely_cause: string;
  suggested_fix: string;
}

// Facts are already masked by the caller: first names and order numbers only.
export type Facts = Record<string, string | number | string[]>;

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'ai');

const INCIDENT_SYSTEM = `You explain automation failures to a business owner who is not technical.
You are given masked facts from an event log: what failed, how often, the errors and a few affected orders (first name and order number only).
You can only read and explain. You cannot change settings, replay events or contact anyone, so never say you did.
Reply with JSON only, no prose around it, in this shape:
{"summary": "...", "likely_cause": "...", "suggested_fix": "..."}
Each field is one to three short, plain sentences. Name the tool, the time window and the numbers from the facts. Do not invent numbers. No em dashes.`;

const ASK_SYSTEM = `You answer a business owner's question about their automations using only the masked facts from the event log you are given.
Answer in plain English in at most 6 short sentences: what happened, when, how many customers were affected, what the system already did about it, and what a person should do next.
You can only read and explain. You cannot change settings or replay events, so never say you did. If the facts do not answer the question, say so. Do not invent numbers. No em dashes.`;

const truthy = (v: Facts[string] | undefined) => (Array.isArray(v) ? v.length > 0 : typeof v === 'number' ? v > 0 : Boolean(v));

// Mustache-style: {{key}} inserts a fact, {{#key}}...{{/key}} keeps text only when the fact is
// non-empty or above zero, {{^key}}...{{/key}} only when it is not.
export function fill(template: string, facts: Facts): string {
  const sections = template
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key: string, inner: string) => (truthy(facts[key]) ? inner : ''))
    .replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key: string, inner: string) => (truthy(facts[key]) ? '' : inner));
  return sections.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = facts[key];
    if (value === undefined) return '';
    return Array.isArray(value) ? value.join(', ') : String(value);
  });
}

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T;
}

let client: Anthropic | null = null;
function anthropic(config: Config): Anthropic {
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

async function callClaude(config: Config, system: string, user: string): Promise<string> {
  const message = await anthropic(config).messages.create({
    model: config.anthropicModel,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('').trim();
}

export async function explainIncident(config: Config, kind: string, facts: Facts): Promise<Explanation & { model: string }> {
  if (!useRealClaude(config)) {
    const t = fixture<Explanation>(`incident-${kind}`);
    return { summary: fill(t.summary, facts), likely_cause: fill(t.likely_cause, facts), suggested_fix: fill(t.suggested_fix, facts), model: 'recorded (demo mode)' };
  }
  const text = await callClaude(config, INCIDENT_SYSTEM, `Incident type: ${kind}\nFacts:\n${scrub(JSON.stringify(facts, null, 2))}`);
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const parsed = JSON.parse(json) as Explanation;
    return { summary: scrub(parsed.summary), likely_cause: scrub(parsed.likely_cause), suggested_fix: scrub(parsed.suggested_fix), model: config.anthropicModel };
  } catch {
    return { summary: scrub(text), likely_cause: 'See summary.', suggested_fix: 'See summary.', model: config.anthropicModel };
  }
}

export async function answerQuestion(config: Config, question: string, topic: string, facts: Facts): Promise<{ answer: string; model: string }> {
  if (!useRealClaude(config)) {
    const t = fixture<{ answer: string; no_failures: string }>(`ask-${topic}`);
    const template = Number(facts.failed_attempts ?? 0) > 0 ? t.answer : t.no_failures;
    return { answer: fill(template, facts), model: 'recorded (demo mode)' };
  }
  const text = await callClaude(config, ASK_SYSTEM, `Question: ${question}\nFacts:\n${scrub(JSON.stringify(facts, null, 2))}`);
  return { answer: scrub(text), model: config.anthropicModel };
}
