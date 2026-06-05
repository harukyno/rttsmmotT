# RTTS MMO Demo Source Audit

Date: 2026-06-05

## Google Doc

- URL: https://docs.google.com/document/d/1mwi_0FxkAvcMfN1PxU-Hz6NzMsJb0ugFfaftnJSup68/edit
- Status: readable through the Google Drive connector.
- Relevant v0 rules confirmed:
  - AP starts at 10 for every unit at turn start.
  - Active order is remaining AP first, then SPD.
  - After an action spends AP, the next active actor is recalculated.
  - Multiple simultaneous skills pay the highest AP cost only.
  - MP and SP costs are summed across all used skills.
  - SPD affects movement distance as SPD/2m in the starter combat map.
- Current implementation coverage:
  - `INITIAL_AP = 10`
  - initiative by remaining AP then SPD
  - stale `turnVersion` rejection
  - 30 second server clock
  - timeout `guard_wait`
  - movement based on SPD/2m

## Google Sheets

- Sheet 1: https://docs.google.com/spreadsheets/d/1e2bF_O8nY3_X-DP0Gmc_3mM5HTqAA3cA0LsMaQwTrLQ/edit
- Sheet 2: https://docs.google.com/spreadsheets/d/1RQJW3ZYrlNRnv5d4N-cKscE4B5hfZqlidWHsiddVPI0/edit
- Sheet 3: https://docs.google.com/spreadsheets/d/13N4j7jDZyQvLbtwr97IoQcM9s1fjrr6iLjbB2-pLsc8/edit
- Status: attempted through the Google Drive Sheets connector; all three returned Sheets API 429 `RATE_LIMIT_EXCEEDED` for the connector project.
- Current v0 fallback:
  - Skill/action seed is curated in `data/seed.json` with Google Doc source notes.
  - Item/equipment/material/magic seed is imported from local `C:\Users\haruk\Downloads\RTTS NMO.xlsx`.

## Local Workbook

- Path: `C:\Users\haruk\Downloads\RTTS NMO.xlsx`
- Status: readable locally.
- Current generated subset:
  - 4 item definitions
  - 6 material definitions
  - 6 magic definitions
- Generated file: `data/generated/rtts-nmo.seed.json`
