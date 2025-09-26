import os
from typing import List, Dict, Any, Optional
from datetime import datetime
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from bson import ObjectId

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "fpv_inventory")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")

app = FastAPI(title="FPV Inventory API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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

# --------- Helpers ---------
def now_iso() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")

def ensure_id(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Use our app-level string id as _id if provided; else generate."""
    if "id" in doc and doc["id"]:
        doc["_id"] = doc["id"]
    else:
        doc["id"] = str(ObjectId())
        doc["_id"] = doc["id"]
    return doc

async def upsert_inventory(part_type_id: str, add_qty: float, unit_cost: float) -> None:
    """
    Moving-average cost update. add_qty can be positive or negative.
    For negative quantity, avgCost stays the same, qty cannot drop below 0 (checked).
    """
    cur = await c_inventory.find_one({"_id": part_type_id})
    if cur is None:
        qty = max(0.0, add_qty)
        avg = unit_cost if qty > 0 else 0.0
        await c_inventory.update_one(
            {"_id": part_type_id},
            {"$set": {"id": part_type_id, "qty": qty, "avgCost": avg}},
            upsert=True,
        )
        return
    qty0 = float(cur.get("qty", 0))
    avg0 = float(cur.get("avgCost", 0))
    qty1 = qty0 + float(add_qty)
    if add_qty >= 0:
        # moving average when adding stock
        if qty1 <= 0:
            avg1 = 0.0
        else:
            avg1 = (qty0 * avg0 + float(add_qty) * float(unit_cost)) / qty1
    else:
        # removing stock doesn't change avg cost
        avg1 = avg0
    if qty1 < 0:
        raise HTTPException(status_code=400, detail=f"Недостатньо на складі для partTypeId={part_type_id}")
    await c_inventory.update_one(
        {"_id": part_type_id},
        {"$set": {"id": part_type_id, "qty": qty1, "avgCost": avg1}},
        upsert=True,
    )

async def inc_product_stock(product_id: str, qty: int) -> None:
    cur = await c_product_stock.find_one({"_id": product_id})
    if cur is None:
        await c_product_stock.update_one(
            {"_id": product_id}, {"$set": {"id": product_id, "qty": int(qty)}}, upsert=True
        )
    else:
        q = int(cur.get("qty", 0)) + int(qty)
        if q < 0:
            raise HTTPException(status_code=400, detail=f"Недостатньо готової продукції для productId={product_id}")
        await c_product_stock.update_one({"_id": product_id}, {"$set": {"id": product_id, "qty": q}}, upsert=True)

async def get_state() -> Dict[str, Any]:
    balance_entries = [x async for x in c_balance.find().sort("date", -1)]
    part_classes = [x async for x in c_part_classes.find().sort("name", 1)]
    part_types = [x async for x in c_part_types.find().sort("name", 1)]
    purchases = [x async for x in c_purchases.find().sort("date", -1)]
    inventory = {doc["id"]: {"qty": doc.get("qty", 0), "avgCost": doc.get("avgCost", 0)} async for doc in c_inventory.find()}
    products = [x async for x in c_products.find().sort("name", 1)]
    assemblies = [x async for x in c_assemblies.find().sort("date", -1)]
    product_stock = {doc["id"]: doc.get("qty", 0) async for doc in c_product_stock.find()}
    sales = [x async for x in c_sales.find().sort("date", -1)]
    # Remove Mongo _id
    for arr in [balance_entries, part_classes, part_types, purchases, products, assemblies, sales]:
        for doc in arr:
            doc.pop("_id", None)
    return {
        "balanceEntries": balance_entries,
        "partClasses": part_classes,
        "partTypes": part_types,
        "purchases": purchases,
        "inventory": inventory,
        "products": products,
        "assemblies": assemblies,
        "productStock": product_stock,
        "sales": sales,
        "version": 1,
    }

# --------- Schemas ---------
class BalanceEntry(BaseModel):
    id: Optional[str] = None
    date: str = Field(default_factory=now_iso)
    type: str  # deposit | withdrawal | purchase | sale
    amount: float
    note: Optional[str] = ""
    tag: Optional[str] = None

class PartClass(BaseModel):
    id: Optional[str] = None
    name: str

class PartType(BaseModel):
    id: Optional[str] = None
    classId: str
    name: str
    unit: Optional[str] = "pcs"
    manufacturer: Optional[str] = ""
    sku: Optional[str] = ""
    note: Optional[str] = ""

class PurchaseItem(BaseModel):
    id: Optional[str] = None
    partTypeId: str
    qty: float
    unitCost: float

class Purchase(BaseModel):
    id: Optional[str] = None
    date: str = Field(default_factory=now_iso)
    vendor: Optional[str] = ""
    items: List[PurchaseItem]
    delivered: bool = False
    paidFromBalance: bool = False
    total: float

class ProductBOMItem(BaseModel):
    id: Optional[str] = None
    partTypeId: str
    qty: float

class Product(BaseModel):
    id: Optional[str] = None
    name: str
    bom: List[ProductBOMItem]
    note: Optional[str] = ""
    suggestedPrice: Optional[float] = None

class Assembly(BaseModel):
    id: Optional[str] = None
    date: str = Field(default_factory=now_iso)
    productId: str
    qty: int

class Sale(BaseModel):
    id: Optional[str] = None
    date: str = Field(default_factory=now_iso)
    productId: str
    qty: int
    pricePerUnit: float
    total: float
    customer: Optional[str] = ""
    note: Optional[str] = ""

# --------- Routes ---------
@app.get("/state")
async def read_state():
    return await get_state()

# Balance
@app.get("/balance/entries")
async def list_balance():
    docs = [x async for x in c_balance.find().sort("date", -1)]
    for d in docs: d.pop("_id", None)
    return docs

@app.post("/balance/entries")
async def add_balance(entry: BalanceEntry):
    doc = ensure_id(entry.model_dump())
    await c_balance.insert_one(doc)
    doc.pop("_id", None)
    return doc

@app.get("/balance/value")
async def balance_value():
    total = 0.0
    async for e in c_balance.find():
        t = e.get("type")
        amt = float(e.get("amount", 0))
        if t in ("deposit", "sale"):
            total += amt
        elif t in ("withdrawal", "purchase"):
            total -= amt
    return {"balance": total}

# Parts
@app.get("/parts/classes")
async def list_part_classes():
    docs = [x async for x in c_part_classes.find().sort("name", 1)]
    for d in docs: d.pop("_id", None)
    return docs

@app.post("/parts/classes")
async def add_part_class(item: PartClass):
    doc = ensure_id(item.model_dump())
    await c_part_classes.insert_one(doc)
    doc.pop("_id", None)
    return doc

@app.get("/parts/types")
async def list_part_types():
    docs = [x async for x in c_part_types.find().sort("name", 1)]
    for d in docs: d.pop("_id", None)
    return docs

@app.post("/parts/types")
async def add_part_type(item: PartType):
    doc = ensure_id(item.model_dump())
    await c_part_types.insert_one(doc)
    doc.pop("_id", None)
    return doc

# Purchases
@app.get("/purchases")
async def list_purchases():
    docs = [x async for x in c_purchases.find().sort("date", -1)]
    for d in docs: d.pop("_id", None)
    return docs

@app.post("/purchases")
async def add_purchase(p: Purchase):
    total = sum([float(it.qty) * float(it.unitCost) for it in p.items])
    doc = ensure_id(p.model_dump())
    doc["total"] = total
    # ensure items have ids
    for it in doc["items"]:
        if not it.get("id"):
            it["id"] = str(ObjectId())
    await c_purchases.insert_one(doc)
    doc.pop("_id", None)
    return doc

@app.post("/purchases/{purchase_id}/mark-delivered")
async def mark_purchase_delivered(purchase_id: str):
    p = await c_purchases.find_one({"_id": purchase_id})
    if not p:
        raise HTTPException(404, "Purchase not found")
    if p.get("delivered"):
        return {"ok": True, "already": True}
    # Update inventory by each item
    for it in p["items"]:
        await upsert_inventory(it["partTypeId"], float(it["qty"]), float(it["unitCost"]))
    await c_purchases.update_one({"_id": purchase_id}, {"$set": {"delivered": True}})
    return {"ok": True}

@app.post("/purchases/{purchase_id}/pay-from-balance")
async def pay_purchase_from_balance(purchase_id: str):
    p = await c_purchases.find_one({"_id": purchase_id})
    if not p:
        raise HTTPException(404, "Purchase not found")
    if p.get("paidFromBalance"):
        return {"ok": True, "already": True}
    entry = {
        "id": str(ObjectId()),
        "_id": None,
        "date": p.get("date") or now_iso(),
        "type": "purchase",
        "amount": float(p.get("total", 0)),
        "note": f"Оплата закупки {p.get('vendor') or '(без постачальника)'}",
        "tag": "Покупка",
    }
    entry["_id"] = entry["id"]
    await c_balance.insert_one(entry)
    await c_purchases.update_one({"_id": purchase_id}, {"$set": {"paidFromBalance": True}})
    return {"ok": True}

# Inventory
@app.get("/inventory")
async def list_inventory():
    docs = [x async for x in c_inventory.find()]
    for d in docs: d.pop("_id", None)
    return docs

# Products
@app.get("/products")
async def list_products():
    docs = [x async for x in c_products.find().sort("name", 1)]
    for d in docs: d.pop("_id", None)
    return docs

@app.post("/products")
async def add_product(p: Product):
    doc = ensure_id(p.model_dump())
    # ensure bom item ids
    for it in doc["bom"]:
        if not it.get("id"):
            it["id"] = str(ObjectId())
    await c_products.insert_one(doc)
    doc.pop("_id", None)
    # initialize stock doc if missing
    await c_product_stock.update_one(
        {"_id": doc["id"]}, {"$setOnInsert": {"id": doc["id"], "qty": 0}}, upsert=True
    )
    return doc

# Assembly
class AssemblyRequest(BaseModel):
    productId: str
    qty: int
    date: Optional[str] = None

@app.post("/assembly")
async def assemble(req: AssemblyRequest):
    product = await c_products.find_one({"_id": req.productId})
    if not product:
        raise HTTPException(404, "Product not found")
    q = int(req.qty)
    if q <= 0:
        raise HTTPException(400, "qty must be > 0")
    # Check inventory
    for b in product["bom"]:
        cur = await c_inventory.find_one({"_id": b["partTypeId"]})
        have = float(cur.get("qty", 0)) if cur else 0.0
        need = float(b["qty"]) * q
        if have < need:
            raise HTTPException(400, f"Недостатньо на складі для {b['partTypeId']}: потрібно {need}, є {have}")
    # Deduct parts
    for b in product["bom"]:
        await upsert_inventory(b["partTypeId"], -float(b["qty"]) * q, 0.0)
    # Increase product stock
    await inc_product_stock(req.productId, q)
    # Add assembly record
    asm = {
        "id": str(ObjectId()),
        "_id": None,
        "date": req.date or now_iso(),
        "productId": req.productId,
        "qty": q,
    }
    asm["_id"] = asm["id"]
    await c_assemblies.insert_one(asm)
    return {"ok": True, "assembly": {k: v for k, v in asm.items() if k != "_id"}}

# Product stock
@app.get("/product-stock")
async def list_product_stock():
    docs = [x async for x in c_product_stock.find()]
    for d in docs: d.pop("_id", None)
    return docs

# Sales
@app.get("/sales")
async def list_sales():
    docs = [x async for x in c_sales.find().sort("date", -1)]
    for d in docs: d.pop("_id", None)
    return docs

class SaleRequest(BaseModel):
    productId: str
    qty: int
    pricePerUnit: float
    date: Optional[str] = None
    customer: Optional[str] = ""
    note: Optional[str] = ""

@app.post("/sales")
async def create_sale(req: SaleRequest):
    stock = await c_product_stock.find_one({"_id": req.productId})
    have = int(stock.get("qty", 0)) if stock else 0
    if have < req.qty:
        raise HTTPException(400, f"Недостатньо готової продукції: потрібно {req.qty}, є {have}")
    # decrement stock
    await inc_product_stock(req.productId, -int(req.qty))
    total = float(req.qty) * float(req.pricePerUnit)
    sale = {
        "id": str(ObjectId()),
        "_id": None,
        "date": req.date or now_iso(),
        "productId": req.productId,
        "qty": int(req.qty),
        "pricePerUnit": float(req.pricePerUnit),
        "total": total,
        "customer": req.customer or "",
        "note": req.note or "",
    }
    sale["_id"] = sale["id"]
    await c_sales.insert_one(sale)
    # balance entry
    be = {
        "id": str(ObjectId()),
        "_id": None,
        "date": sale["date"],
        "type": "sale",
        "amount": total,
        "note": f"Продаж {req.qty} шт.",
        "tag": "Продаж",
    }
    be["_id"] = be["id"]
    await c_balance.insert_one(be)
    return {"ok": True, "sale": {k: v for k, v in sale.items() if k != "_id"}}

# Startup: indexes
@app.on_event("startup")
async def on_startup():
    # Унікальні індекси, де потрібно
    await c_part_classes.create_index("name", unique=True)
    await c_part_types.create_index([("classId", 1), ("name", 1)], unique=True)
    await c_products.create_index("name", unique=True)

    # На _id індекс створювати НЕ потрібно — він вже існує і є унікальним
    # await c_inventory.create_index("_id", unique=True)      # ✗ (забрати)
    # await c_product_stock.create_index("_id", unique=True)  # ✗ (забрати)

    # Звичайні індекси для сортування/запитів
    await c_purchases.create_index("date")
    await c_sales.create_index([("date", -1)])
    await c_balance.create_index([("date", -1)])