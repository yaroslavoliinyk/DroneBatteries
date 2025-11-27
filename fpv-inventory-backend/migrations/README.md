# Database Migrations

This directory contains database migration and snapshot management scripts.

## 📸 Database Snapshots (003_snapshot.py)

**Create snapshots before deploying to protect your data!**

### Quick Start

```bash
# Create snapshot before deploy
docker exec -it fpv-backend python migrations/003_snapshot.py create

# Create snapshot with description
docker exec -it fpv-backend python migrations/003_snapshot.py create --name "before_feature_x"

# List all snapshots
docker exec -it fpv-backend python migrations/003_snapshot.py list

# Restore from snapshot (if something goes wrong)
docker exec -it fpv-backend python migrations/003_snapshot.py restore <snapshot_name>
```

### Commands

| Command | Description |
|---------|-------------|
| `create` | Create a new snapshot |
| `create -n "name"` | Create snapshot with custom name |
| `list` | List all available snapshots |
| `restore <name>` | Restore database from snapshot |
| `delete <name>` | Delete a specific snapshot |
| `cleanup --days 30` | Delete snapshots older than 30 days |

### Shell Script Wrapper

```bash
# Or use the shell script wrapper
./migrations/snapshot.sh create
./migrations/snapshot.sh create -n "before_deploy_v2"
./migrations/snapshot.sh list
./migrations/snapshot.sh restore fpv_snap_20251127_143000
```

### Example Workflow (Before Deploy)

```bash
# 1. Create snapshot
docker exec -it fpv-backend python migrations/003_snapshot.py create --name "pre_deploy_$(date +%Y%m%d)"

# 2. Deploy your changes
git push origin develop

# 3. If something breaks, restore:
docker exec -it fpv-backend python migrations/003_snapshot.py restore <snapshot_name>
```

---

## 🔄 Copy Production to Stage (002_copy_to_stage.py)

Copies all data from `fpv_inventory` database to `fpv_inventory_stage` database.

**Usage:**

```bash
# From the project root directory
cd fpv-inventory-backend

# Run migration (uses .env or default MongoDB URI)
python migrations/002_copy_to_stage.py

# Or specify MongoDB URI directly
MONGODB_URI=mongodb://localhost:27017 python migrations/002_copy_to_stage.py

# Or if using Docker
docker exec -it fpv-backend python migrations/002_copy_to_stage.py
```

**What it does:**
- Connects to MongoDB using `MONGODB_URI` from environment or default `mongodb://localhost:27017`
- Copies all collections from `fpv_inventory` to `fpv_inventory_stage`
- Collections copied:
  - balance_entries
  - part_classes
  - part_types
  - purchases
  - inventory
  - products
  - assemblies
  - product_stock
  - sales
  - suppliers
  - stock_ops
  - settings
  - customers
- Drops target collections before copying (ensures clean copy)
- Preserves document IDs (`_id` and `id` fields)

**Note:** This script will overwrite any existing data in `fpv_inventory_stage` database.

