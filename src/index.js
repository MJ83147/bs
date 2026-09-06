import { handleInteraction } from './discord.js';
import { handleApi } from './api.js';
import { poll } from './poller.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/interactions' && request.method === 'POST') return handleInteraction(request, env, ctx);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    if (url.pathname === '/health') return new Response('ok');
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(poll(env));
  },
};
