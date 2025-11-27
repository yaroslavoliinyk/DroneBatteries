"""
Migration script: Copy all data from fpv_inventory to fpv_inventory_stage

Usage:
    python migrations/002_copy_to_stage.py

Or with environment variables:
    MONGODB_URI=mongodb://localhost:27017 python migrations/002_copy_to_stage.py
"""
import os
import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
# Always copy FROM fpv_inventory TO fpv_inventory_stage (don't use DB_NAME env var)
SOURCE_DB_NAME = "fpv_inventory"
TARGET_DB_NAME = "fpv_inventory_stage"

# All collections to copy (from db.py)
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


async def copy_collection(source_collection, target_collection, collection_name):
    """Copy all documents from source to target collection."""
    count = 0
    async for doc in source_collection.find({}):
        # Create a copy of the document
        doc_copy = doc.copy()

        # Preserve _id if it exists, otherwise use 'id' field as _id
        if "_id" not in doc_copy and "id" in doc_copy:
            doc_copy["_id"] = doc_copy["id"]

        await target_collection.insert_one(doc_copy)
        count += 1

    return count


async def migrate():
    """Main migration function."""
    print(f"Connecting to MongoDB: {MONGODB_URI}")
    client = AsyncIOMotorClient(MONGODB_URI)

    try:
        # Get source and target databases
        source_db = client[SOURCE_DB_NAME]
        target_db = client[TARGET_DB_NAME]

        print(f"\nSource database: {SOURCE_DB_NAME}")
        print(f"Target database: {TARGET_DB_NAME}\n")

        # Check if source database exists
        db_list = await client.list_database_names()
        if SOURCE_DB_NAME not in db_list:
            print(f"ERROR: Source database '{SOURCE_DB_NAME}' does not exist!")
            print(f"Available databases: {', '.join(db_list)}")
            return

        # Get list of collections in source database
        source_collections = await source_db.list_collection_names()
        print(f"Found {len(source_collections)} collections in source database")

        total_docs = 0

        # Copy each collection
        for collection_name in COLLECTIONS:
            source_collection = source_db[collection_name]
            target_collection = target_db[collection_name]

            # Check if collection exists and has documents
            doc_count = await source_collection.count_documents({})

            if doc_count == 0:
                print(f"  ⏭️  Skipping '{collection_name}' (empty)")
                continue

            print(f"  📋 Copying '{collection_name}' ({doc_count} documents)...", end=" ", flush=True)

            # Drop target collection if it exists (to ensure clean copy)
            await target_collection.drop()

            # Copy all documents
            copied = await copy_collection(source_collection, target_collection, collection_name)
            total_docs += copied

            print(f"✅ Copied {copied} documents")

        # Also copy any other collections that might exist but aren't in our list
        other_collections = [c for c in source_collections if c not in COLLECTIONS]
        if other_collections:
            print(f"\n⚠️  Found {len(other_collections)} additional collections not in standard list:")
            for collection_name in other_collections:
                source_collection = source_db[collection_name]
                doc_count = await source_collection.count_documents({})
                if doc_count > 0:
                    print(f"  📋 Copying '{collection_name}' ({doc_count} documents)...", end=" ", flush=True)
                    target_collection = target_db[collection_name]
                    await target_collection.drop()
                    copied = await copy_collection(source_collection, target_collection, collection_name)
                    total_docs += copied
                    print(f"✅ Copied {copied} documents")

        print(f"\n✅ Migration completed successfully!")
        print(f"   Total documents copied: {total_docs}")
        print(f"   Target database: {TARGET_DB_NAME}")

    except Exception as e:
        print(f"\n❌ Error during migration: {e}")
        raise
    finally:
        client.close()


if __name__ == "__main__":
    print("=" * 60)
    print("Database Migration: fpv_inventory → fpv_inventory_stage")
    print("=" * 60)

    asyncio.run(migrate())

