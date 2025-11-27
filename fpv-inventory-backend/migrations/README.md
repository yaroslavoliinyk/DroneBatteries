# Database Migrations

This directory contains database migration scripts.

## Available Migrations

### 002_copy_to_stage.py
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

