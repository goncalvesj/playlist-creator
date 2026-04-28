# Azure Deployment Plan

> **Status:** Ready for Validation

Generated: 2026-04-27T17:20:02.793+01:00

---

## 1. Project Overview

**Goal:** Create a manual deployment script for an existing Azure Static Web App using a deployment token.

**Path:** Modify Existing

---

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | Existing Static Web App deployment |
| Scale | Existing service |
| Budget | No new resources planned |
| Subscription | Existing Azure subscription; no provisioning required |
| Location | Existing Static Web App; no provisioning required |

---

## 3. Components Detected

| Component | Type | Technology | Path |
|-----------|------|------------|------|
| playlist-creator | Frontend | React, TypeScript, Vite | `src` |
| api | API | Azure Static Web Apps API, Node.js 20 | `api` |
| staticwebapp.config.json | Static Web Apps config | SWA routing/runtime config | `staticwebapp.config.json` |

---

## 4. Recipe Selection

**Selected:** Manual Static Web Apps CLI deployment script (PowerShell)

**Rationale:** The Azure Static Web App already exists and the user has a deployment token, so no infrastructure generation is needed.

---

## 5. Architecture

**Stack:** Azure Static Web Apps

### Service Mapping

| Component | Azure Service | SKU |
|-----------|---------------|-----|
| Frontend and API | Existing Azure Static Web App | Existing |

### Supporting Services

| Service | Purpose |
|---------|---------|
| Deployment token | Authenticates manual deployment |

---

## 6. Provisioning Limit Checklist

No new Azure resources will be provisioned by this task, so quota validation is not applicable.

| Resource Type | Number to Deploy | Total After Deployment | Limit/Quota | Notes |
|---------------|------------------|------------------------|-------------|-------|
| N/A | 0 | Existing resources unchanged | N/A | Manual deployment only |

**Status:** No quota impact

---

## 7. Execution Checklist

### Phase 1: Planning
- [x] Analyze workspace
- [x] Gather script requirements
- [x] Scan codebase
- [x] Select recipe
- [x] Plan architecture
- [x] User approved this plan

### Phase 2: Execution
- [x] Create deployment script
- [x] Document required environment variable for deployment token
- [x] Add API package ignore rules for local settings and dependencies
- [x] Verify build/deployment command shape locally where possible
- [x] Update plan status to "Ready for Validation"

### Phase 3: Validation
- [x] Validate script syntax and project build

### Phase 4: Deployment
- [ ] User runs deployment script with their deployment token

---

## 8. Validation Proof

| Check | Command Run | Result | Timestamp |
|-------|-------------|--------|-----------|
| PowerShell syntax | `[System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw .\deploy-static-web-app.ps1), [ref]$errors)` | Pass | 2026-04-27T17:20:02.793+01:00 |
| Frontend build | `npm run build` | Pass | 2026-04-27T17:20:02.793+01:00 |
| API build | `npm --prefix api run build` | Pass | 2026-04-27T17:20:02.793+01:00 |
| SWA CLI command shape | `npx -y @azure/static-web-apps-cli@latest deploy --help` | Pass | 2026-04-27T17:20:02.793+01:00 |
| Existing lint | `npm run lint` | Fails in pre-existing `src\auth\useSpotify.ts` and `src\pages\Review.tsx`; deployment script unaffected | 2026-04-27T17:20:02.793+01:00 |

---

## 9. Files to Generate

| File | Purpose | Status |
|------|---------|--------|
| `.azure/deployment-plan.md` | This plan | Created |
| `deploy-static-web-app.ps1` | Manual SWA deployment | Created |
| `api/.funcignore` | Prevent local API settings and dependencies from deployment packaging | Created |
| `README.md` | Deployment usage documentation | Updated |

---

## 10. Next Steps

> Current: Ready for validation

1. Review the deployment script.
2. Run `.\deploy-static-web-app.ps1` with `SWA_CLI_DEPLOYMENT_TOKEN` set when ready to deploy.
