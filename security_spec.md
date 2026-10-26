# Security Specification — Mantrana AI Firestore Rules

## 1. Data Invariants
1. **Default Deny**: All paths not explicitly matched (`/users/{userId}` and `/users/{userId}/sessions/{sessionId}`) are denied for both reads and writes.
2. **PII & Owner Isolation**: User profile documents (`/users/{userId}`) contain PII (`email`, `username`) and can ONLY be read (`get`), created, or updated by the authenticated owner (`request.auth.uid == userId`). Blanket `list` or non-owner `get` is forbidden.
3. **Master Gate Relational Sync**: A chat session (`/users/{userId}/sessions/{sessionId}`) cannot be created, read (`get`), updated, or deleted unless the parent `/users/{userId}` document exists and its `ownerId` matches `request.auth.uid`.
4. **Immutable Identity & Temporal Integrity**: `ownerId`, `email`/`userEmail`, and `createdAt` cannot be modified after creation. `createdAt` and `updatedAt` must equal `request.time`.

## 2. Dirty Dozen Adversarial Payloads
1. **Unauthenticated Profile Creation**: `auth = null` attempting `create` on `/users/u1` -> `PERMISSION_DENIED`.
2. **Cross-User Profile Read (PII Leak)**: `auth.uid = 'attacker'` attempting `get` on `/users/victim` -> `PERMISSION_DENIED`.
3. **User Enumeration (List Users)**: `auth.uid = 'attacker'` attempting `list` on `/users` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection on Profile**: Adding `isAdmin: true` to `/users/u1` -> `PERMISSION_DENIED` via `hasOnly`.
5. **Identity Spoofing on Profile**: `auth.uid = 'u1'` setting `ownerId: 'u2'` -> `PERMISSION_DENIED`.
6. **Oversized Username Poisoning**: `username` with 5,000 chars -> `PERMISSION_DENIED` (`size() <= 60`).
7. **Immutable Email Tampering**: Updating `email` on `/users/u1` -> `PERMISSION_DENIED` via `affectedKeys().hasOnly(['username', 'updatedAt'])`.
8. **Orphaned Session Creation**: Creating `/users/u1/sessions/s1` when `/users/u1` does not exist -> `PERMISSION_DENIED` via Master Gate `get()`.
9. **Cross-User Session Scraping**: `auth.uid = 'attacker'` querying `list` on `/users/victim/sessions` -> `PERMISSION_DENIED`.
10. **Forged Timestamp Injection**: Setting `createdAt` or `updatedAt` to a past/future timestamp instead of `request.time` -> `PERMISSION_DENIED`.
11. **ID Poisoning Attack**: Creating a session with non-alphanumeric path ID or >128 chars -> `PERMISSION_DENIED` via `isValidId()`.
12. **Unauthorised Action Key Update on Session**: Modifying `createdAt` or `ownerId` during session update -> `PERMISSION_DENIED`.
