import asyncio
from db import (
    c_part_classes,
    c_part_types,
    c_products,
    c_suppliers,
    c_purchases,
    c_inventory,
    c_product_stock,
    c_sales,
)

async def run():
    # Ensure indexes exist (idempotent)
    await c_part_classes.create_index("name", unique=True)
    await c_part_types.create_index([("classId", 1), ("name", 1)], unique=True)
    await c_products.create_index("name", unique=True)
    await c_suppliers.create_index("name", unique=True)
    await c_purchases.create_index("date")
    await c_sales.create_index([("date", -1)])

if __name__ == "__main__":
    asyncio.run(run())


