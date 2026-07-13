"""Data-access repositories.

Repositories encapsulate all persistence operations. Services depend on
repositories, not directly on SQLAlchemy. This lets us swap or mock the
storage layer without touching business logic.
"""
