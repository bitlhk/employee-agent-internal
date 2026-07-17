# Third-Party Notices

Workforce Agent Platform uses third-party open-source software and integration
names. Exact dependency versions are recorded in `pnpm-lock.yaml`; package
copyright and license metadata remains available in each installed package.

## Runtime and Framework Libraries

- React, React DOM, Vite, TypeScript, ESLint, Vitest
- Express, tRPC, Drizzle ORM, mysql2, ws
- React Markdown, remark-gfm, rehype-highlight, highlight.js
- remend 1.3.0, Copyright 2023 Vercel, Inc., Apache License 2.0.
  The distributed notice is available at
  `client/public/licenses/remend-Apache-2.0.txt` and is included in the
  production frontend build.
- Radix UI primitives, lucide-react icons, Tailwind CSS
- qrcode for local QR code rendering
- Noto Sans SC 5.2.8, Copyright Google Inc., SIL Open Font License 1.1.
  The required license text is distributed at
  `client/public/licenses/Noto-Sans-SC-OFL-1.1.txt` and is included in the
  production frontend build.
- UI components derived from shadcn/ui, Copyright 2023 shadcn, MIT License.
  The license text is distributed at
  `client/public/licenses/shadcn-ui-MIT.txt` and is included in the production
  frontend build.

## Integration Names and Trademarks

The product can integrate with external runtimes and channels such as
JiuwenSwarm, A2A-compatible agents, Feishu/Lark, WeChat, WeCom, and DingTalk.
Those names and marks belong to their respective owners. The open-source
repository does not grant trademark rights. The repository does not distribute
their channel or runtime logo artwork; see `ASSET_PROVENANCE.md`.

## Deployment-Specific Assets

Enterprise-specific skills, MCP tools, Agent manifests, prompts, datasets,
logos, channel credentials, and customer-specific configurations are deployment
assets. They should be stored outside this public repository unless their owner
has explicitly approved publication under the repository license.
