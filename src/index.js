import { handleInteraction, registerCommands, debugCommands } from './discord.js';
import { handleApi } from './api.js';
import { poll } from './poller.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/interactions' && request.method === 'POST') return handleInteraction(request, env, ctx);
    if (url.pathname === '/register' && url.searchParams.get('key') === env.SITE_PASSWORD) return registerCommands(env);
    if (url.pathname === '/debug' && url.searchParams.get('key') === env.SITE_PASSWORD) return debugCommands(env);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    if (url.pathname === '/health') return new Response('ok');
    // The roster snapshot is served only through the authed /api/team-status
    // endpoint, never as a public file.
    if (url.pathname === '/team-status.jsonl') return new Response('Not found', { status: 404 });
    // Pretty URL for the team status page: serve the app shell and let the
    // client-side router open the page.
    if (url.pathname === '/team') return env.ASSETS.fetch(new URL('/', request.url).toString());
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(poll(env));
  },
};
