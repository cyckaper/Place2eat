// Netlify Function (CommonJS / classic handler): AI restaurant matching via Claude.
// The user's free-text request + a candidate list are sent here; Claude ranks the
// best fits and writes a one-line reason for each. The Anthropic API key stays
// server-side (Netlify env var ANTHROPIC_API_KEY) — never exposed to the browser.

const MODEL = 'claude-haiku-4-5-20251001'; // cheap & fast; swap to 'claude-sonnet-4-6' for deeper reasoning

function resp(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'method_not_allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return resp(500, { error: 'no_key' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return resp(400, { error: 'bad_json' }); }

  const { description, places = [], lang = 'en' } = body;
  if (!description || !places.length) return resp(200, { matches: [] });

  const list = places.slice(0, 20).map((p) =>
    `#${p.i} | ${p.name} | ${p.primaryType || (p.types || []).slice(0, 3).join(',') || 'restaurant'}`
    + ` | price ${p.price || 'n/a'} | rating ${p.rating == null ? 'n/a' : p.rating} (${p.reviews == null ? 0 : p.reviews} reviews)`
    + (p.address ? ` | ${p.address}` : '')
  ).join('\n');

  const system =
    `You help a diner pick a restaurant. You are given their request and a numbered list of candidate places `
    + `(name, cuisine type, price level, rating, review count, address). Choose the candidates that genuinely fit the `
    + `request, weighing cuisine, budget/price, occasion, the vibe implied by cuisine type and price, and location. `
    + `Rank them best-first. For each pick, write one short reason (max ~18 words) written in the language with BCP-47 `
    + `code "${lang}", addressed directly to the diner, saying why it fits. Include only good matches (up to 8). If none `
    + `fit, return an empty list. Respond with ONLY valid JSON, no markdown fences: `
    + `{"matches":[{"i":<candidate number>,"reason":"<text>"}]}`;

  const userMsg = `Request: ${description}\n\nCandidates:\n${list}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return resp(502, { error: 'anthropic_error', detail });
    }

    const data = await r.json();
    let text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { matches: [] };
    }

    const matches = Array.isArray(parsed.matches)
      ? parsed.matches.filter((x) => x && typeof x.i === 'number').map((x) => ({ i: x.i, reason: String(x.reason || '') }))
      : [];

    return resp(200, { matches });
  } catch (e) {
    return resp(502, { error: 'fetch_failed', detail: String(e) });
  }
};
