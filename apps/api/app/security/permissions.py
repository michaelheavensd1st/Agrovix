"""Canonical permission + role catalogue.

Sprint 1 keeps *everything* permission-driven — nothing in the auth
check path should ever look at a role name. Roles here are simply
convenient bundles of permissions applied at a scope.

To extend the model:
* add permission code(s) to :data:`ALL_PERMISSIONS`
* wire them into :data:`ROLE_DEFINITIONS`
* run ``alembic upgrade head`` then the seeder — the seeder is
  idempotent so it is safe to call on every deploy.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.role import RoleScope


@dataclass(frozen=True)
class PermissionDef:
    code: str
    description: str


@dataclass(frozen=True)
class RoleDef:
    name: str
    scope: RoleScope
    description: str
    permissions: tuple[str, ...]


ALL_PERMISSIONS: tuple[PermissionDef, ...] = (
    PermissionDef("platform.admin", "Full platform administration"),
    PermissionDef("organization.read", "Read organization details"),
    PermissionDef("organization.update", "Update organization details"),
    PermissionDef("organization.delete", "Delete an organization"),
    PermissionDef("organization.member.invite", "Invite a user to an organization"),
    PermissionDef("organization.member.remove", "Remove a member from an organization"),
    PermissionDef("organization.role.assign", "Assign roles to organization members"),
    PermissionDef("farm.read", "Read farms in scope"),
    PermissionDef("farm.create", "Create farms in an organization"),
    PermissionDef("farm.update", "Update farms"),
    PermissionDef("farm.delete", "Soft-delete farms"),
    PermissionDef("farm.restore", "Restore a soft-deleted farm"),
    PermissionDef("farm.member.assign", "Grant a user access to a farm"),
    PermissionDef("audit.read", "View audit events for the organization"),
    PermissionDef("invitation.create", "Create invitations"),
    PermissionDef("invitation.revoke", "Revoke invitations"),
    PermissionDef("invitation.list", "List invitations"),
    # --- Production Engine (Sprint 2) --- #
    PermissionDef("production_site.read", "Read production sites"),
    PermissionDef("production_site.create", "Create production sites"),
    PermissionDef("production_site.update", "Update production sites"),
    PermissionDef("production_site.delete", "Soft-delete production sites"),
    PermissionDef("production_site.restore", "Restore soft-deleted sites"),
    PermissionDef("production_unit_type.read", "Read production unit types"),
    PermissionDef("production_unit_type.create", "Create custom production unit types"),
    PermissionDef("production_unit_type.delete", "Delete custom production unit types"),
    PermissionDef("production_unit.read", "Read production units"),
    PermissionDef("production_unit.create", "Create production units"),
    PermissionDef("production_unit.update", "Update production units"),
    PermissionDef("production_unit.delete", "Soft-delete production units"),
    PermissionDef("production_batch.read", "Read production batches"),
    PermissionDef("production_batch.create", "Create production batches"),
    PermissionDef("production_batch.update", "Update production batches"),
    PermissionDef("production_batch.transition", "Change production batch lifecycle state"),
    PermissionDef("production_event.read", "Read production events"),
    PermissionDef("production_event.create", "Create production events"),
    # --- Sprint 4 — Operational Resources (Inventory) --- #
    PermissionDef("inventory_warehouse.read", "Read warehouses"),
    PermissionDef("inventory_warehouse.create", "Create warehouses"),
    PermissionDef("inventory_warehouse.update", "Update warehouses"),
    PermissionDef("inventory_warehouse.delete", "Soft-delete warehouses"),
    PermissionDef("inventory_item.read", "Read inventory catalog items"),
    PermissionDef("inventory_item.create", "Create inventory catalog items"),
    PermissionDef("inventory_item.update", "Update inventory catalog items"),
    PermissionDef("inventory_item.delete", "Soft-delete inventory catalog items"),
    PermissionDef("inventory_lot.read", "Read inventory lots + balances"),
    PermissionDef("inventory_lot.create", "Create inventory lots (typically via receipt)"),
    PermissionDef("inventory_lot.update", "Update inventory lot metadata"),
    PermissionDef("inventory_transaction.read", "Read the inventory ledger"),
    PermissionDef(
        "inventory_transaction.create",
        "Post ledger transactions (receipt/issue/transfer/adjustment/reversal)",
    ),
)


def _codes(*codes: str) -> tuple[str, ...]:
    return codes


ROLE_DEFINITIONS: tuple[RoleDef, ...] = (
    RoleDef(
        "platform_admin",
        RoleScope.PLATFORM,
        "Platform-wide administrator",
        _codes("platform.admin"),
    ),
    RoleDef(
        "organization_owner",
        RoleScope.ORGANIZATION,
        "Owner of an organization",
        _codes(
            "organization.read",
            "organization.update",
            "organization.delete",
            "organization.member.invite",
            "organization.member.remove",
            "organization.role.assign",
            "farm.read",
            "farm.create",
            "farm.update",
            "farm.delete",
            "farm.restore",
            "farm.member.assign",
            "audit.read",
            "invitation.create",
            "invitation.revoke",
            "invitation.list",
            # Production Engine — owners can do everything.
            "production_site.read",
            "production_site.create",
            "production_site.update",
            "production_site.delete",
            "production_site.restore",
            "production_unit_type.read",
            "production_unit_type.create",
            "production_unit_type.delete",
            "production_unit.read",
            "production_unit.create",
            "production_unit.update",
            "production_unit.delete",
            "production_batch.read",
            "production_batch.create",
            "production_batch.update",
            "production_batch.transition",
            "production_event.read",
            "production_event.create",
            # Sprint 4 — owners can do everything.
            "inventory_warehouse.read",
            "inventory_warehouse.create",
            "inventory_warehouse.update",
            "inventory_warehouse.delete",
            "inventory_item.read",
            "inventory_item.create",
            "inventory_item.update",
            "inventory_item.delete",
            "inventory_lot.read",
            "inventory_lot.create",
            "inventory_lot.update",
            "inventory_transaction.read",
            "inventory_transaction.create",
        ),
    ),
    RoleDef(
        "farm_director",
        RoleScope.ORGANIZATION,
        "Director overseeing multiple farms in an organization",
        _codes(
            "organization.read",
            "farm.read",
            "farm.create",
            "farm.update",
            "farm.member.assign",
            "audit.read",
            "invitation.create",
            "invitation.list",
            "production_site.read",
            "production_site.create",
            "production_site.update",
            "production_unit_type.read",
            "production_unit.read",
            "production_unit.create",
            "production_unit.update",
            "production_batch.read",
            "production_batch.create",
            "production_batch.update",
            "production_batch.transition",
            "production_event.read",
            "production_event.create",
            "inventory_warehouse.read",
            "inventory_warehouse.create",
            "inventory_warehouse.update",
            "inventory_item.read",
            "inventory_item.create",
            "inventory_item.update",
            "inventory_lot.read",
            "inventory_lot.create",
            "inventory_lot.update",
            "inventory_transaction.read",
            "inventory_transaction.create",
        ),
    ),
    RoleDef(
        "farm_manager",
        RoleScope.FARM,
        "Manages the operations of a single farm",
        _codes(
            "organization.read",
            "farm.read",
            "farm.update",
            "farm.member.assign",
            "invitation.create",
            "invitation.list",
            "production_site.read",
            "production_site.update",
            "production_unit_type.read",
            "production_unit.read",
            "production_unit.create",
            "production_unit.update",
            "production_batch.read",
            "production_batch.create",
            "production_batch.update",
            "production_batch.transition",
            "production_event.read",
            "production_event.create",
            "inventory_warehouse.read",
            "inventory_item.read",
            "inventory_lot.read",
            "inventory_lot.create",
            "inventory_transaction.read",
            "inventory_transaction.create",
        ),
    ),
    RoleDef(
        "supervisor",
        RoleScope.FARM,
        "Supervises daily operations at a farm",
        _codes(
            "organization.read",
            "farm.read",
            "production_site.read",
            "production_unit.read",
            "production_unit_type.read",
            "production_batch.read",
            "production_event.read",
            "production_event.create",
            "inventory_warehouse.read",
            "inventory_item.read",
            "inventory_lot.read",
            "inventory_transaction.read",
        ),
    ),
    RoleDef(
        "storekeeper",
        RoleScope.FARM,
        "Manages farm inventory and stores",
        _codes(
            "organization.read",
            "farm.read",
            "production_site.read",
            "production_unit.read",
            "production_batch.read",
            "production_event.read",
            "production_event.create",
            # Storekeepers own inventory ops end-to-end at their farm.
            "inventory_warehouse.read",
            "inventory_item.read",
            "inventory_lot.read",
            "inventory_lot.create",
            "inventory_lot.update",
            "inventory_transaction.read",
            "inventory_transaction.create",
        ),
    ),
    RoleDef(
        "veterinarian",
        RoleScope.FARM,
        "Farm veterinarian",
        _codes(
            "organization.read",
            "farm.read",
            "production_site.read",
            "production_unit.read",
            "production_batch.read",
            "production_event.read",
            "production_event.create",
            "inventory_item.read",
            "inventory_lot.read",
            "inventory_transaction.read",
        ),
    ),
    RoleDef(
        "accountant",
        RoleScope.ORGANIZATION,
        "Handles finances across the organization",
        _codes(
            "organization.read",
            "farm.read",
            "audit.read",
            "production_site.read",
            "production_unit.read",
            "production_batch.read",
            "production_event.read",
            "inventory_warehouse.read",
            "inventory_item.read",
            "inventory_lot.read",
            "inventory_transaction.read",
        ),
    ),
    RoleDef(
        "worker",
        RoleScope.FARM,
        "General farm worker",
        _codes(
            "farm.read",
            "production_unit.read",
            "production_batch.read",
            "production_event.read",
            "production_event.create",
            "inventory_item.read",
            "inventory_lot.read",
        ),
    ),
    RoleDef(
        "viewer",
        RoleScope.ORGANIZATION,
        "Read-only observer",
        _codes(
            "organization.read",
            "farm.read",
            "production_site.read",
            "production_unit.read",
            "production_unit_type.read",
            "production_batch.read",
            "production_event.read",
            "inventory_warehouse.read",
            "inventory_item.read",
            "inventory_lot.read",
            "inventory_transaction.read",
        ),
    ),
)
