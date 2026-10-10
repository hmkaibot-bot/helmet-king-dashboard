# Helmet King Marketing OS — MVP v0.1

Status: development design only; no production migration or deployment.

## Scope
Semi-automatic, Helmet King only. Phase 1 produces Cantonese/English copy, IG 4:5 graphics and A4/A3 visual merchandising posters. All products, logos, colorways and source image assets must remain unchanged. Human approval is mandatory.

## Technical integration
Reuse existing React/Vite/Tailwind UI, Supabase Auth/RLS, Vercel server functions and documented Shopify/n8n jobs. Confirm actual dashboard Supabase project before migrations; do not assume CONTENT HUB or inventory DB is the Dashboard production DB.

## 8 agents
Manager: sequence, dependency and approval gates.
Copywriter: HK voice, factual copy.
Graphic Designer: deterministic layout with unchanged Shopify product images.
VM Designer: print-safe A4/A3/A2/A1 templates and PDF.
Researcher: date-stamped HK market evidence.
Creative Strategist: audience/hooks/feasible concepts.
Performance Analyst: attribution-aware metrics, phase 2.
QA: programmatic price/SKU/stock validation, document checks, independent visual review.

## Workflow
draft -> approved brief -> copy/design/VM -> QA -> human approval -> export. Failed QA returns to originator; snapshots and all versions must be recorded. Publishing, spend or Shopify price changes require explicit human approval.

## Minimum screens
Marketing Overview; Campaigns; Brief Editor; Product and Image Picker; Production Studio; QA Inbox; Approvals; Settings.

## Proposed new tables
marketing_campaigns, marketing_products_snapshot, marketing_asset_sources, marketing_prompt_versions, marketing_jobs, marketing_outputs, marketing_qa_checks, marketing_approvals, marketing_events.
See downloadable starter package for full reviewed migration draft, full prompts and backlog.

## Acceptance
One approved Halloween campaign brief -> two Cantonese variants, one English caption, IG 1080x1350 image, A4 poster; SKU, picture, stock, price and terms sourced and checked. Incorrect or missing facts must prevent approval.

## Security blockers
Existing repository README reports historical service_role key leak. Confirm rotation. Supabase inspection flagged RLS disabled on 36 CONTENT HUB tables and nine shopify-inventory-ops tables. Do not enable RLS on existing tables without designing policies and assessing production impact. New marketing tables must be private by default.
