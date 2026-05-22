
## What I understood the problem to be

Agnost is an analytics layer for AI agents — "Google Analytics for AI agents."  
The core value: understanding **what users actually want**, not just what the agent returns.

Track B asks: make it trivially easy for a developer using Vercel AI SDK, OpenAI SDK, or Mastra to plug into Agnost. The bar isn't "can you write an adapter." It's: **can a developer who's never heard of Agnost be up and running in under 2 minutes, with zero risk of breaking their production agent?**

That reframing changed every decision below.

## Why pnpm workspace over npm/yarn?
 Hoisting is more predictable, lockfile is smaller.



