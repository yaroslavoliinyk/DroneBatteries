import os
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "fpv_inventory")

client = AsyncIOMotorClient(MONGODB_URI)
db = client[DB_NAME]

# Collections
c_balance = db["balance_entries"]
c_part_classes = db["part_classes"]
c_part_types = db["part_types"]
c_purchases = db["purchases"]
c_inventory = db["inventory"]
c_products = db["products"]
c_assemblies = db["assemblies"]
c_product_stock = db["product_stock"]
c_sales = db["sales"]
c_suppliers = db["suppliers"]
c_stock_ops = db["stock_ops"]


