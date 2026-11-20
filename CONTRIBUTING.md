# Contributing

Thanks for helping! A few rules keep `main` working for everyone.

## Workflow

1. Fork the repo and create a branch from `main`.
2. `npm install`, make your change, and run:
   ```bash
   npm run typecheck
   npm test
   ```
3. Open a pull request using the template. CI runs automatically:
   - **Build & test**: TypeScript check plus the offline tests (no accounts, browsers or network needed)
   - **Secret scan**: gitleaks blocks cookies, tokens and keys
   - **Dependency audit**: no critical vulnerabilities in production dependencies
4. `main` is protected: a PR can only be merged when all three checks pass, **a maintainer has approved it**, and every review conversation is resolved. New commits dismiss earlier approvals.
5. PRs and issues may also get an automated review comment starting with `🤖 Orca`. It's advice for the maintainer; the human approval is what counts.

## Guidelines

- **Never include** `.env`, `cookies/`, `data/` (except `*.example.json`), `output/`, `models/` or `browser-profile/`.
- **Add a test** for logic that can run offline (see `src/test-seo.ts` and `src/test-queue.ts` for the style).
- **Test rendering/publishing changes with `DRY_RUN=true`** and say so in the PR.
- **Platform limits change**: if you update one (hashtag counts, caption length…), link the source in the PR.
- **Keep the safety rails**: changes that weaken the permission checks, credit, or monetization/safety gate need a clear reason.

## Reporting a security issue

Don't open a public issue for leaked credentials or vulnerabilities; contact the maintainer through GitHub first.
