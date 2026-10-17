// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Test preload (server/bunfig.toml): pin the VM class for every server test (issue #4349).
 *
 * `isTenantVm()` (@hapi/protocol/tenantMode) reads ~/.config/hapimatic/vm-{tier,class}. On an
 * operator cloud VM that predates its class-marker backfill (ms1) it would read as a TENANT, and
 * every usage / model-catalog / login test would silently take the tenant path on that host only.
 * Pinning the class here keeps the suite host-independent; a tenant test sets HAPI_VM_TIER and
 * HAPI_VM_CLASS=tenant itself (and restores them).
 */
process.env.HAPI_VM_CLASS ??= "operator";
