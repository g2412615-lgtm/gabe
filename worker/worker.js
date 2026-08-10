// worker/worker.js — Cloudflare Worker proxying AI drafting calls so the
// Anthropic API key never touches the client. POST /draft only. Stateless:
// nothing about the payload is logged.
//
// Deploy:  npx wrangler secret put ANTHROPIC_API_KEY && npx wrangler deploy
// Then paste the Worker URL (with /draft) into config.js DRAFT_ENDPOINT.

import { RULEBOOK } from '../forms/froi/rulebook.js';

// Edit this list when the production site URL is known. localhost/127.0.0.1
// on any port is always allowed for development.
const PROD_ORIGINS = [
  'https://froi-builder.pages.dev', // <- replace with the real Cloudflare Pages origin
];

const REQUIRED_KEYS = [
  'location_description', 'incident_description', 'activity_description',
  'injury_description', 'direct_cause', 'detailed_narrative',
  'specific_injury', 'suggested_incident_type', 'suggested_classification',
  'classification_rationale', 'flags',
];

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

function allowedOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  if (PROD_ORIGINS.includes(origin)) return origin;
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return origin;
  } catch { /* malformed origin header */ }
  return null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(payload, status, origin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...(origin ? corsHeaders(origin) : {}) },
  });
}

function stripFences(text) {
  let t = (text || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const m = fence.exec(t);
  if (m) t = m[1].trim();
  // Some responses wrap prose around the object — grab the outermost braces.
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first > 0 && last > first) t = t.slice(first, last + 1);
  return t;
}

function parseAndValidate(text) {
  if (!text) return null;
  let obj;
  try { obj = JSON.parse(stripFences(text)); } catch { return null; }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  for (const k of REQUIRED_KEYS) {
    if (!(k in obj)) return null;
  }
  if (!Array.isArray(obj.flags)) return null;
  // Return only the expected keys — never pass through extras.
  const out = {};
  for (const k of REQUIRED_KEYS) out[k] = obj[k];
  return out;
}

async function callClaude(env, messages) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      temperature: 0.2,
      system: RULEBOOK,
      messages,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data.content)) return null;
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request);

    if (request.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/draft') {
      return json({ error: 'not found' }, 404, origin);
    }
    if (!origin) return json({ error: 'origin not allowed' }, 403, null);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'worker missing ANTHROPIC_API_KEY secret' }, 500, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400, origin); }
    const facts = body && typeof body.facts === 'object' && body.facts !== null ? body.facts : {};
    const notes = typeof body?.notes === 'string' ? body.notes : '';

    const userMsg = [
      'FACTS (structured answers from the report wizard):',
      JSON.stringify(facts, null, 2),
      '',
      'RAW NOTES (conversational, possibly voice-transcribed):',
      notes || '(none provided)',
      '',
      `Write the FROI narrative fields from these facts and notes. Respond with ONLY a JSON object containing exactly these keys: ${REQUIRED_KEYS.join(', ')}. "flags" is an array of strings noting anything ambiguous or missing; "suggested_classification" is one of "Workers Comp", "Near Miss", or "Unclear"; "suggested_incident_type" is one of: Altercation, Fall From Height, Hit By Vehicle, Other, Slip & Fall, Slip & No Fall, Trip & Fall, Trip & No Fall, Vehicle Accident.`,
    ].join('\n');

    const first = await callClaude(env, [{ role: 'user', content: userMsg }]);
    let parsed = parseAndValidate(first);
    if (!parsed) {
      const retryMessages = [{ role: 'user', content: userMsg }];
      if (first && first.trim()) {
        retryMessages.push({ role: 'assistant', content: first });
        retryMessages.push({ role: 'user', content: 'Return only valid JSON' });
      }
      const second = await callClaude(env, retryMessages);
      parsed = parseAndValidate(second);
    }
    if (!parsed) return json({ error: 'drafting failed' }, 502, origin);
    return json(parsed, 200, origin);
  },
};
