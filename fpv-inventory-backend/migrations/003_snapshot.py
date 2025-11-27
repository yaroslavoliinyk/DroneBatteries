"""
Database Snapshot Management Script

Usage:
    # Create a snapshot before deploy:
    python migrations/003_snapshot.py create

    # Create snapshot with custom name:
    python migrations/003_snapshot.py create --name "before_feature_x"

    # List all snapshots:
    python migrations/003_snapshot.py list

    # Restore from a snapshot:
    python migrations/003_snapshot.py restore fpv_snap_20251127_143000

    # Delete a snapshot:
    python migrations/003_snapshot.py delete fpv_snap_20251127_143000

    # Delete all snapshots older than N days:
    python migrations/003_snapshot.py cleanup --days 30
"""
import os
import sys
import asyncio
import argparse
from datetime import datetime, timedelta
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
# SOURCE_DB_NAME = os.getenv("DB_NAME", "fpv_inventory_stage")
SOURCE_DB_NAME = "fpv_inventory"
# Short prefix to stay under MongoDB Atlas 38-byte limit
SNAPSHOT_PREFIX = "fpv_snap_"

# All collections to copy
COLLECTIONS = [
    "balance_entries",
    "part_classes",
    "part_types",
    "purchases",
    "inventory",
    "products",
    "assemblies",
    "product_stock",
    "sales",
    "suppliers",
    "stock_ops",
    "settings",
    "customers",
]


async def copy_database(client, source_db_name: str, target_db_name: str) -> int:
    """Copy all collections from source to target database."""
    source_db = client[source_db_name]
    target_db = client[target_db_name]

    total_docs = 0
    source_collections = await source_db.list_collection_names()

    # Copy standard collections
    for collection_name in COLLECTIONS:
        if collection_name not in source_collections:
            continue

        source_collection = source_db[collection_name]
        target_collection = target_db[collection_name]

        doc_count = await source_collection.count_documents({})
        if doc_count == 0:
            continue

        print(f"  📋 Copying '{collection_name}' ({doc_count} docs)...", end=" ", flush=True)

        # Drop target collection first
        await target_collection.drop()

        # Copy all documents
        async for doc in source_collection.find({}):
            await target_collection.insert_one(doc.copy())
            total_docs += 1

        print("✅")

    # Copy any additional collections
    other_collections = [c for c in source_collections if c not in COLLECTIONS]
    for collection_name in other_collections:
        source_collection = source_db[collection_name]
        doc_count = await source_collection.count_documents({})
        if doc_count == 0:
            continue

        print(f"  📋 Copying '{collection_name}' ({doc_count} docs)...", end=" ", flush=True)
        target_collection = target_db[collection_name]
        await target_collection.drop()

        async for doc in source_collection.find({}):
            await target_collection.insert_one(doc.copy())
            total_docs += 1

        print("✅")

    return total_docs


async def create_snapshot(name: str = None):
    """Create a database snapshot."""
    # Use compact timestamp format: YYYYMMDD_HHMMSS (15 chars)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    if name:
        # Sanitize name and truncate to fit MongoDB Atlas 38-byte limit
        safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)
        # Limit name to 10 chars to stay under 38 bytes: fpv_snap_ (9) + timestamp (15) + _ (1) + name (max 13)
        safe_name = safe_name[:13]
        snapshot_db_name = f"{SNAPSHOT_PREFIX}{timestamp}_{safe_name}"
        # Ensure total length <= 38 bytes
        if len(snapshot_db_name) > 38:
            # Truncate name further if needed
            max_name_len = 38 - len(SNAPSHOT_PREFIX) - len(timestamp) - 1
            safe_name = safe_name[:max_name_len]
            snapshot_db_name = f"{SNAPSHOT_PREFIX}{timestamp}_{safe_name}"
    else:
        snapshot_db_name = f"{SNAPSHOT_PREFIX}{timestamp}"

    print("=" * 60)
    print(f"Creating Database Snapshot")
    print("=" * 60)
    print(f"Source: {SOURCE_DB_NAME}")
    print(f"Snapshot: {snapshot_db_name}")
    print(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("-" * 60)

    client = AsyncIOMotorClient(MONGODB_URI)

    try:
        # Check if source exists
        db_list = await client.list_database_names()
        if SOURCE_DB_NAME not in db_list:
            print(f"❌ Error: Source database '{SOURCE_DB_NAME}' not found!")
            return

        total_docs = await copy_database(client, SOURCE_DB_NAME, snapshot_db_name)

        # Store metadata in snapshot
        snapshot_db = client[snapshot_db_name]
        await snapshot_db["_snapshot_metadata"].insert_one({
            "_id": "metadata",
            "source_db": SOURCE_DB_NAME,
            "created_at": datetime.utcnow(),
            "name": name,
            "documents_count": total_docs
        })

        print("-" * 60)
        print(f"✅ Snapshot created successfully!")
        print(f"   Name: {snapshot_db_name}")
        print(f"   Documents: {total_docs}")
        print(f"\nTo restore: python migrations/003_snapshot.py restore {snapshot_db_name}")

    except Exception as e:
        print(f"❌ Error: {e}")
        raise
    finally:
        client.close()


async def list_snapshots():
    """List all available snapshots."""
    print("=" * 60)
    print("Available Database Snapshots")
    print("=" * 60)

    client = AsyncIOMotorClient(MONGODB_URI)

    try:
        db_list = await client.list_database_names()
        snapshots = [db for db in db_list if db.startswith(SNAPSHOT_PREFIX)]

        if not snapshots:
            print("No snapshots found.")
            return

        snapshots.sort(reverse=True)  # Newest first

        print(f"Found {len(snapshots)} snapshot(s):\n")

        for i, snapshot_name in enumerate(snapshots, 1):
            # Try to get metadata
            snapshot_db = client[snapshot_name]
            metadata = await snapshot_db["_snapshot_metadata"].find_one({"_id": "metadata"})

            if metadata:
                created = metadata.get("created_at", "Unknown")
                if isinstance(created, datetime):
                    created = created.strftime("%Y-%m-%d %H:%M:%S UTC")
                docs = metadata.get("documents_count", "?")
                name = metadata.get("name", "")
                name_str = f" ({name})" if name else ""
            else:
                created = "Unknown"
                docs = "?"
                name_str = ""

            print(f"  {i}. {snapshot_name}{name_str}")
            print(f"     Created: {created}, Documents: {docs}")
            print()

    finally:
        client.close()


async def restore_snapshot(snapshot_name: str):
    """Restore database from a snapshot."""
    print("=" * 60)
    print(f"Restoring Database from Snapshot")
    print("=" * 60)
    print(f"Snapshot: {snapshot_name}")
    print(f"Target: {SOURCE_DB_NAME}")
    print("-" * 60)

    # Confirm
    confirm = input(f"⚠️  This will OVERWRITE '{SOURCE_DB_NAME}'. Continue? [y/N]: ").strip().lower()
    if confirm != 'y':
        print("Aborted.")
        return

    client = AsyncIOMotorClient(MONGODB_URI)

    try:
        db_list = await client.list_database_names()
        if snapshot_name not in db_list:
            print(f"❌ Error: Snapshot '{snapshot_name}' not found!")
            print("\nAvailable snapshots:")
            for db in db_list:
                if db.startswith(SNAPSHOT_PREFIX):
                    print(f"  - {db}")
            return

        total_docs = await copy_database(client, snapshot_name, SOURCE_DB_NAME)

        print("-" * 60)
        print(f"✅ Restore completed!")
        print(f"   Documents restored: {total_docs}")

    except Exception as e:
        print(f"❌ Error: {e}")
        raise
    finally:
        client.close()


async def delete_snapshot(snapshot_name: str):
    """Delete a snapshot."""
    if not snapshot_name.startswith(SNAPSHOT_PREFIX):
        print(f"❌ Error: '{snapshot_name}' is not a snapshot database!")
        return

    print(f"Deleting snapshot: {snapshot_name}")

    confirm = input(f"⚠️  This will permanently delete '{snapshot_name}'. Continue? [y/N]: ").strip().lower()
    if confirm != 'y':
        print("Aborted.")
        return

    client = AsyncIOMotorClient(MONGODB_URI)

    try:
        await client.drop_database(snapshot_name)
        print(f"✅ Snapshot '{snapshot_name}' deleted.")
    except Exception as e:
        print(f"❌ Error: {e}")
        raise
    finally:
        client.close()


async def cleanup_old_snapshots(days: int):
    """Delete snapshots older than N days."""
    print(f"Cleaning up snapshots older than {days} days...")

    client = AsyncIOMotorClient(MONGODB_URI)
    cutoff = datetime.utcnow() - timedelta(days=days)

    try:
        db_list = await client.list_database_names()
        snapshots = [db for db in db_list if db.startswith(SNAPSHOT_PREFIX)]

        deleted = 0
        for snapshot_name in snapshots:
            snapshot_db = client[snapshot_name]
            metadata = await snapshot_db["_snapshot_metadata"].find_one({"_id": "metadata"})

            if metadata and metadata.get("created_at"):
                created = metadata["created_at"]
                if isinstance(created, datetime) and created < cutoff:
                    print(f"  Deleting: {snapshot_name} (created {created.strftime('%Y-%m-%d')})")
                    await client.drop_database(snapshot_name)
                    deleted += 1

        print(f"\n✅ Deleted {deleted} old snapshot(s).")

    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser(description="Database Snapshot Management")
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # Create
    create_parser = subparsers.add_parser("create", help="Create a new snapshot")
    create_parser.add_argument("--name", "-n", help="Optional name/description for the snapshot")

    # List
    subparsers.add_parser("list", help="List all snapshots")

    # Restore
    restore_parser = subparsers.add_parser("restore", help="Restore from a snapshot")
    restore_parser.add_argument("snapshot_name", help="Name of snapshot to restore")

    # Delete
    delete_parser = subparsers.add_parser("delete", help="Delete a snapshot")
    delete_parser.add_argument("snapshot_name", help="Name of snapshot to delete")

    # Cleanup
    cleanup_parser = subparsers.add_parser("cleanup", help="Delete old snapshots")
    cleanup_parser.add_argument("--days", "-d", type=int, default=30, help="Delete snapshots older than N days")

    args = parser.parse_args()

    if args.command == "create":
        asyncio.run(create_snapshot(args.name))
    elif args.command == "list":
        asyncio.run(list_snapshots())
    elif args.command == "restore":
        asyncio.run(restore_snapshot(args.snapshot_name))
    elif args.command == "delete":
        asyncio.run(delete_snapshot(args.snapshot_name))
    elif args.command == "cleanup":
        asyncio.run(cleanup_old_snapshots(args.days))
    else:
        parser.print_help()
        print("\n📌 Quick examples:")
        print("  Create snapshot:  python migrations/003_snapshot.py create")
        print("  Create with name: python migrations/003_snapshot.py create --name 'before_feature_x'")
        print("  List snapshots:   python migrations/003_snapshot.py list")
        print("  Restore:          python migrations/003_snapshot.py restore <snapshot_name>")


if __name__ == "__main__":
    main()

