# Contributing to Polyester Market Maker

Thank you for contributing to the Polyester DEX Market Maker & Trading Bot repository! This guide details our workflow standards, coding conventions, testing requirements, and Git push procedures.

---

## 1. Development Environment

- **Node.js**: Version 22.0.0 or higher.
- **Package Manager**: `npm` (v10+).
- **TypeScript**: Strict mode enabled in `tsconfig.json`.

### Setup
```bash
# Clone the repository
git clone https://github.com/datphuocnguyen04/polyester-market-maker.git
cd polyester-market-maker

# Install dependencies
npm install

# Setup test environment variables
cp .env.example .env
```

---

## 2. Git Workflow

### 2.1 Branching Convention
Create focused branches for your work using standard prefixes:
- `feature/<description>` or `feat/<description>` for new functionality
- `fix/<description>` for bug fixes
- `refactor/<description>` for structural improvements
- `docs/<description>` for documentation updates

```bash
git checkout -b feat/dynamic-spread-adjustment
```

### 2.2 Commit Message Standards
We enforce [Conventional Commits](https://www.conventionalcommits.org/):

Format:
```
<type>(<optional scope>): <description>

[optional body]
```

Examples:
- `feat(market-maker): adjust quote spreads based on 1m realized volatility`
- `fix(signer): preserve sorting order in query string normalization`
- `docs: add troubleshooting steps for 403 API responses`
- `test(u128): add edge-case checks for max uint128 values`

---

## 3. Code Standards & Best Practices

1. **Strict ESM**: Always use explicit `.js` extensions for relative file imports (e.g., `import { logger } from "./lib/logger.js"`).
2. **Deterministic Math**: Use BigInt and fixed-point helpers in `src/lib/u128.ts` for monetary and token quantities to prevent floating-point precision loss.
3. **Post-Only Quoting**: Limit orders must remain post-only to ensure maker fee tiers.
4. **Error Handling**: Gracefully catch network errors and API timeouts without crashing continuous trading loops.

---

## 4. Verification & Testing

Every change must pass our verification gates:

```bash
# Run TypeScript type check
npm run typecheck

# Run test suite
npm test

# Verify quote computation in dry-run mode
npm run dry
```

---

## 5. Security & Sensitive Files

Never stage or commit sensitive configuration files or credentials:
- `.env`
- `wallets.json`
- `state.json` or `state*.json`
- `logs/` or `*.log` files

Before staging files, check `git status` to ensure no private keys or local runtime files are included.

---

## 6. Submitting Changes

1. Stage only the files relevant to your change:
   ```bash
   git add src/services/marketMaker.ts test/marketMaker.test.ts
   ```
2. Verify staged diffs:
   ```bash
   git diff --staged
   ```
3. Commit your changes:
   ```bash
   git commit -m "feat(market-maker): optimize post-only quote placement"
   ```
4. Push your branch to the remote:
   ```bash
   git push origin feat/dynamic-spread-adjustment
   ```
5. Open a Pull Request against the `main` branch.
