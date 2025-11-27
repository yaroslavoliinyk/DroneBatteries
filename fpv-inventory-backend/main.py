import os
import logging

from typing import List, Dict, Any, Optional
from datetime import datetime
from zoneinfo import ZoneInfo
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from db import (
    db,
    c_balance,
    c_part_classes,
    c_part_types,
    c_purchases,
    c_inventory,
    c_products,
    c_assemblies,
    c_product_stock,
    c_sales,
    c_suppliers,
    c_stock_ops,
    settings,
    customers,
)
from bson import ObjectId

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "fpv_inventory_stage")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")

app = FastAPI(title="FPV Inventory API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN, "http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = AsyncIOMotorClient(MONGODB_URI)

# --------- Helpers ---------
def now_iso() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")

def now_kyiv_str() -> str:
    try:
        return datetime.now(ZoneInfo("Europe/Kiev")).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

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

async def log_stock_op(op_type: str, part_type_id: str, qty: float, message: str, meta: Optional[Dict[str, Any]] = None) -> None:
    pt = await c_part_types.find_one({"_id": part_type_id})
    cls = await c_part_classes.find_one({"_id": (pt or {}).get("classId")}) if pt else None
    doc = {
        "id": str(ObjectId()),
        "_id": None,
        "datetimeKyiv": now_kyiv_str(),
        "type": op_type,  # replenish | writeoff | purchase | assembly_use | sale_consume | status_change
        "classId": (pt or {}).get("classId"),
        "className": (cls or {}).get("name"),
        "partTypeId": part_type_id,
        "partTypeName": (pt or {}).get("name"),
        "qty": float(qty),
        "message": message,
        "meta": meta or {},
    }
    doc["_id"] = doc["id"]
    await c_stock_ops.insert_one(doc)

async def add_value_to_inventory(part_type_id: str, extra_value: float) -> None:
    """
    Add pure value to inventory without changing quantity.
    This is used to distribute additional costs (e.g. delivery) to the
    moving-average cost of items that are already in stock.
    new_avg = (qty * avg + extra_value) / qty, if qty > 0
    """
    if abs(float(extra_value)) <= 0:
        return
    cur = await c_inventory.find_one({"_id": part_type_id})
    if not cur:
        # If there is no inventory yet, we cannot add value; skip safely
        return
    qty = float(cur.get("qty", 0))
    if qty <= 0:
        return
    avg = float(cur.get("avgCost", 0))
    new_avg = (qty * avg + float(extra_value)) / qty
    await c_inventory.update_one(
        {"_id": part_type_id}, {"$set": {"avgCost": new_avg}}, upsert=True
    )

async def rebuild_inventory_and_stock() -> None:
    """
    Recompute inventory quantities/avg costs and product stock from persisted events:
    - Delivered purchases add to inventory; additional costs are allocated by value share
    - Assemblies deduct parts from inventory and increase product stock
    - Allocated sales decrease product stock (unallocated sales should not affect stock)
    """
    # reset
    await c_inventory.delete_many({})
    await c_product_stock.delete_many({})

    # 1) Apply all delivered purchases (skip services)
    async for p in c_purchases.find({"delivered": True}):
        if p.get("isService"):
            continue
        items = p.get("items", [])
        additional_costs = p.get("additionalCosts", [])
        items_total = sum([float(it.get("qty", 0)) * float(it.get("unitCost", 0)) for it in items if it.get("partTypeId")])
        costs_total = sum([float(c.get("amount", 0)) for c in additional_costs])
        for it in items:
            if not it.get("partTypeId"):
                continue  # service row
            qty = float(it.get("qty", 0))
            unit_cost = float(it.get("unitCost", 0))
            base_value = qty * unit_cost
            share = (base_value / items_total) * costs_total if items_total > 0 else 0.0
            effective_unit = unit_cost if qty <= 0 else (unit_cost + share / qty)
            await upsert_inventory(it["partTypeId"], qty, effective_unit)

    # 2) Apply assemblies
    async for asm in c_assemblies.find():
        q = int(asm.get("qty", 0))
        product = await c_products.find_one({"_id": asm.get("productId")})
        if not product or q <= 0:
            continue
        # Always deduct parts (taken into assembly at start) for pcs only
        for b in product.get("bom", []):
            pt = await c_part_types.find_one({"_id": b.get("partTypeId")})
            unit = (pt or {}).get("unit") or "pcs"
            if unit == "pcs":
                await upsert_inventory(b["partTypeId"], -float(b.get("qty", 0)) * q, 0.0)
        # Only increase finished goods stock for completed (or legacy without status)
        status = asm.get("status")
        if status in (None, "completed"):
            await inc_product_stock(product["id"], q)

    # 3) Apply only allocated sales
    async for s in c_sales.find({"allocated": True}):
        await inc_product_stock(s.get("productId"), -int(s.get("qty", 0)))

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
    balance_entries = [x async for x in c_balance.find().sort([("date", -1), ("_id", -1)])]
    part_classes = [x async for x in c_part_classes.find().sort("name", 1)]
    part_types = [x async for x in c_part_types.find().sort("name", 1)]
    purchases = [x async for x in c_purchases.find({"archived": {"$ne": True}}).sort("date", -1)]
    inventory = {doc["id"]: {"qty": doc.get("qty", 0), "avgCost": doc.get("avgCost", 0)} async for doc in c_inventory.find()}
    products = [x async for x in c_products.find().sort("name", 1)]
    assemblies = [x async for x in c_assemblies.find().sort("date", -1)]
    product_stock = {doc["id"]: doc.get("qty", 0) async for doc in c_product_stock.find()}
    sales = [x async for x in c_sales.find({"archived": {"$ne": True}}).sort("date", -1)]
    suppliers = [x async for x in c_suppliers.find().sort("name", 1)]
    # Remove Mongo _id
    for arr in [balance_entries, part_classes, part_types, purchases, products, assemblies, sales, suppliers]:
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
        "suppliers": suppliers,
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
    color: Optional[str] = None
    icon: Optional[str] = None  # optional lucide icon name

class PartType(BaseModel):
    id: Optional[str] = None
    classId: str
    name: str
    unit: Optional[str] = "pcs"
    supplierId: Optional[str] = None
    note: Optional[str] = ""
    stockStatus: Optional[str] = None  # ok | low | none (manual status for non-pcs)
    # deprecated fields (kept for backward compatibility on input)
    manufacturer: Optional[str] = None
    sku: Optional[str] = None
    runningLow: Optional[bool] = None
    runningLowThreshold: Optional[float] = None

class PurchaseItem(BaseModel):
    id: Optional[str] = None
    partTypeId: Optional[str] = None  # None => service line (no inventory impact)
    qty: float
    unitCost: float
    note: Optional[str] = ""
    isService: Optional[bool] = False

class AdditionalCost(BaseModel):
    id: Optional[str] = None
    amount: float
    description: str
    date: str = Field(default_factory=now_iso)

class Purchase(BaseModel):
    id: Optional[str] = None
    date: str = Field(default_factory=now_iso)
    vendor: Optional[str] = ""
    items: List[PurchaseItem]
    delivered: bool = False
    paidFromBalance: bool = False
    total: float
    additionalCosts: Optional[List[AdditionalCost]] = []
    isService: bool = False
    archived: bool = False

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

class SupplierLink(BaseModel):
    id: Optional[str] = None
    title: Optional[str] = ""
    url: str

class Supplier(BaseModel):
    id: Optional[str] = None
    name: str
    website: Optional[str] = ""
    links: Optional[List[SupplierLink]] = []
    classIds: Optional[List[str]] = []
    typeIds: Optional[List[str]] = []
    note: Optional[str] = ""

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
    taxExempt: Optional[bool] = False

class Customer(BaseModel):
    id: Optional[str] = None
    numericId: Optional[int] = None
    name: str
    contacts: Optional[str] = ""

class InventoryFilters(BaseModel):
    productIds: Optional[List[str]] = []
    classIds: Optional[List[str]] = []
    typeIds: Optional[List[str]] = []

# --------- Routes ---------
@app.get("/state")
async def read_state():
    return await get_state()
# --------- Customers ---------
@app.get("/customers")
async def list_customers():
    docs = [x async for x in customers.find().sort("numericId", 1)]
    for d in docs:
        d.pop("_id", None)
    return docs

@app.post("/customers")
async def add_customer(body: Customer):
    # auto-increment numericId
    last = await customers.find_one(sort=[("numericId", -1)])
    next_num = int((last or {}).get("numericId", 0)) + 1
    doc = {
        "id": str(ObjectId()),
        "_id": None,
        "numericId": next_num,
        "name": body.name,
        "contacts": body.contacts or "",
    }
    doc["_id"] = doc["id"]
    await customers.insert_one(doc)
    doc.pop("_id", None)
    return doc

@app.put("/customers/{cid}")
async def update_customer(cid: str, body: Customer):
    patch = {}
    if body.name is not None:
        patch["name"] = body.name
    if body.contacts is not None:
        patch["contacts"] = body.contacts
    if not patch:
        return {"ok": True}
    await customers.update_one({"_id": cid}, {"$set": patch})
    return {"ok": True}

@app.delete("/customers/{cid}")
async def delete_customer(cid: str):
    await customers.delete_one({"_id": cid})
    return {"ok": True}

@app.get("/customers/summary")
async def customers_summary():
    # Aggregate sales by customer
    pipeline = [
        {"$group": {"_id": "$customer", "totalQty": {"$sum": "$qty"}, "totalAmount": {"$sum": "$total"}, "products": {"$push": {"productId": "$productId", "qty": "$qty"}}}},
    ]
    data = []
    async for row in db["sales"].aggregate(pipeline):
        name = row.get("_id") or ""
        # Build product counts by productId
        prod_counts = {}
        for p in row.get("products", []) or []:
            pid = p.get("productId")
            q = int(p.get("qty", 0))
            if pid:
                prod_counts[pid] = prod_counts.get(pid, 0) + q
        # Map to list with product names
        items = []
        for pid, q in prod_counts.items():
            prod = await c_products.find_one({"_id": pid})
            items.append({"productId": pid, "productName": (prod or {}).get("name") or pid, "qty": q})
        data.append({
            "customer": name,
            "items": items,
            "totalQty": int(row.get("totalQty", 0)),
            "totalAmount": float(row.get("totalAmount", 0)),
        })
    return data

# --------- Settings (persist UI preferences) ---------
@app.get("/settings/inventory-filters")
async def get_inventory_filters():
    doc = await settings.find_one({"_id": "inventory_filters"})
    if not doc:
        return {"productIds": [], "classIds": [], "typeIds": []}
    return {"productIds": doc.get("productIds", []), "classIds": doc.get("classIds", []), "typeIds": doc.get("typeIds", [])}

@app.post("/settings/inventory-filters")
async def set_inventory_filters(body: InventoryFilters):
    payload = {
        "_id": "inventory_filters",
        "productIds": list(dict.fromkeys(body.productIds or [])),
        "classIds": list(dict.fromkeys(body.classIds or [])),
        "typeIds": list(dict.fromkeys(body.typeIds or [])),
    }
    await settings.update_one({"_id": "inventory_filters"}, {"$set": payload}, upsert=True)
    return {"ok": True}

class BalanceRules(BaseModel):
    allowDelete: bool = False
    allowAdd: bool = True

@app.get("/settings/balance-rules")
async def get_balance_rules():
    doc = await settings.find_one({"_id": "balance_rules"})
    return {
        "allowDelete": bool((doc or {}).get("allowDelete", False)),
        "allowAdd": bool((doc or {}).get("allowAdd", True)),
    }

@app.post("/settings/balance-rules")
async def set_balance_rules(body: BalanceRules):
    payload = {"_id": "balance_rules", "allowDelete": bool(body.allowDelete), "allowAdd": bool(body.allowAdd)}
    await settings.update_one({"_id": "balance_rules"}, {"$set": payload}, upsert=True)
    return {"ok": True}

# Inventory Rules (admin permissions for editing avgCost)
class InventoryRules(BaseModel):
    allowEditAvgCost: bool = False

@app.get("/settings/inventory-rules")
async def get_inventory_rules():
    doc = await settings.find_one({"_id": "inventory_rules"})
    return {
        "allowEditAvgCost": bool((doc or {}).get("allowEditAvgCost", False)),
    }

@app.post("/settings/inventory-rules")
async def set_inventory_rules(body: InventoryRules):
    payload = {"_id": "inventory_rules", "allowEditAvgCost": bool(body.allowEditAvgCost)}
    await settings.update_one({"_id": "inventory_rules"}, {"$set": payload}, upsert=True)
    return {"ok": True}

# Update inventory avgCost (admin only)
class UpdateAvgCostRequest(BaseModel):
    avgCost: float = Field(..., ge=0.01, description="Minimum avgCost is 0.01")

@app.put("/inventory/{part_type_id}/avg-cost")
async def update_inventory_avg_cost(part_type_id: str, body: UpdateAvgCostRequest):
    rules = await settings.find_one({"_id": "inventory_rules"})
    if not rules or not bool(rules.get("allowEditAvgCost", False)):
        raise HTTPException(403, "Editing average cost is not allowed. Enable it in Settings.")
    if body.avgCost < 0.01:
        raise HTTPException(400, "Average cost must be at least 0.01")
    cur = await c_inventory.find_one({"_id": part_type_id})
    if not cur:
        raise HTTPException(404, f"Inventory item not found: {part_type_id}")
    await c_inventory.update_one(
        {"_id": part_type_id},
        {"$set": {"avgCost": float(body.avgCost)}}
    )
    return {"ok": True, "avgCost": body.avgCost}

# Balance
@app.get("/balance/entries")
async def list_balance():
    docs = [x async for x in c_balance.find().sort("date", -1)]
    for d in docs: d.pop("_id", None)
    return docs

@app.post("/balance/entries")
async def add_balance(entry: BalanceEntry):
    rules = await settings.find_one({"_id": "balance_rules"})
    if rules and not bool(rules.get("allowAdd", True)):
        raise HTTPException(403, "Balance entries cannot be added now")
    doc = ensure_id(entry.model_dump())
    await c_balance.insert_one(doc)
    doc.pop("_id", None)
    return doc

class UpdateBalanceEntryRequest(BaseModel):
    date: Optional[str] = None
    type: Optional[str] = None
    amount: Optional[float] = None
    note: Optional[str] = None
    tag: Optional[str] = None

@app.put("/balance/entries/{entry_id}")
async def update_balance_entry(entry_id: str, body: UpdateBalanceEntryRequest):
    raise HTTPException(403, "Balance entries are immutable")

@app.delete("/balance/entries/{entry_id}")
async def delete_balance_entry(entry_id: str):
    rules = await settings.find_one({"_id": "balance_rules"})
    if not rules or not bool(rules.get("allowDelete", False)):
        raise HTTPException(403, "Balance entries cannot be deleted")
    await c_balance.delete_one({"_id": entry_id})
    return {"ok": True}

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
    payload = item.model_dump()
    sid = payload.get("supplierId")
    if sid:
        sup = await c_suppliers.find_one({"_id": sid})
        if not sup:
            raise HTTPException(400, "Вказаний supplierId не існує")
    # strip deprecated
    payload.pop("manufacturer", None)
    payload.pop("sku", None)
    payload.pop("runningLow", None)
    doc = ensure_id(payload)
    await c_part_types.insert_one(doc)
    doc.pop("_id", None)
    return doc

# --- Updates & Deletes for Parts ---
class UpdatePartClassRequest(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    icon: Optional[str] = None


@app.put("/parts/classes/{class_id}")
async def update_part_class(class_id: str, body: UpdatePartClassRequest):
    cls = await c_part_classes.find_one({"_id": class_id})
    if not cls:
        raise HTTPException(404, "Part class not found")
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not patch:
        return {"ok": True}
    await c_part_classes.update_one({"_id": class_id}, {"$set": patch})
    return {"ok": True}


@app.delete("/parts/classes/{class_id}")
async def delete_part_class(class_id: str):
    cls = await c_part_classes.find_one({"_id": class_id})
    if not cls:
        raise HTTPException(404, "Part class not found")
    # Prevent deletion if there are part types under this class
    has_types = await c_part_types.find_one({"classId": class_id})
    if has_types:
        raise HTTPException(400, "Неможливо видалити: клас має прив'язані види деталей")
    # Remove references from suppliers.classIds
    await c_suppliers.update_many({}, {"$pull": {"classIds": class_id}})
    await c_part_classes.delete_one({"_id": class_id})
    return {"ok": True}


class UpdatePartTypeRequest(BaseModel):
    classId: Optional[str] = None
    name: Optional[str] = None
    unit: Optional[str] = None
    supplierId: Optional[str] = None
    note: Optional[str] = None
    layer: Optional[str] = None
    packParallel: Optional[str] = None
    # deprecated inputs ignored if provided
    manufacturer: Optional[str] = None
    sku: Optional[str] = None
    runningLow: Optional[bool] = None
    runningLowThreshold: Optional[float] = None
    stockStatus: Optional[str] = None  # ok | low | none (for non-pcs manual status)


@app.put("/parts/types/{type_id}")
async def update_part_type(type_id: str, body: UpdatePartTypeRequest):
    pt = await c_part_types.find_one({"_id": type_id})
    if not pt:
        raise HTTPException(404, "Part type not found")
    old_running_low = bool(pt.get("runningLow"))
    old_status = pt.get("stockStatus") or ("low" if old_running_low else "ok")
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    # If classId changed, ensure class exists
    new_class_id = patch.get("classId")
    if new_class_id is not None:
        cls = await c_part_classes.find_one({"_id": new_class_id})
        if not cls:
            raise HTTPException(400, "Вказаний classId не існує")
    # Validate supplier
    new_supplier_id = patch.get("supplierId")
    if new_supplier_id is not None:
        if new_supplier_id != "":
            sup = await c_suppliers.find_one({"_id": new_supplier_id})
            if not sup:
                raise HTTPException(400, "Вказаний supplierId не існує")
    # Strip deprecated fields if present (keep runningLowThreshold for threshold persistence)
    for k in ("manufacturer", "sku"):
        if k in patch:
            patch.pop(k, None)
    # normalize runningLow if provided
    if "runningLow" in body.model_dump(exclude_unset=True):
        patch["runningLow"] = bool(body.runningLow)
    # validate stockStatus if provided
    if "stockStatus" in patch and patch["stockStatus"] not in ("ok", "low", "none"):
        raise HTTPException(400, "stockStatus must be one of: ok, low, none")
    if not patch:
        return {"ok": True}
    await c_part_types.update_one({"_id": type_id}, {"$set": patch})
    # log status change if any
    new_running_low = patch.get("runningLow", old_running_low)
    new_status = patch.get("stockStatus") or ("low" if new_running_low else "ok")
    if new_status != old_status:
        await log_stock_op("status_change", type_id, 0.0, f"Статус: {old_status} → {new_status}")
    return {"ok": True}


@app.delete("/parts/types/{type_id}")
async def delete_part_type(type_id: str):
    pt = await c_part_types.find_one({"_id": type_id})
    if not pt:
        raise HTTPException(404, "Part type not found")
    # Block delete if referenced in purchases or products' BOM
    used_in_purchase = await c_purchases.find_one({"items": {"$elemMatch": {"partTypeId": type_id}}})
    if used_in_purchase:
        raise HTTPException(400, "Неможливо видалити: вид використовується в закупках")
    used_in_product = await c_products.find_one({"bom": {"$elemMatch": {"partTypeId": type_id}}})
    if used_in_product:
        raise HTTPException(400, "Неможливо видалити: вид використовується у специфікаціях продуктів")
    # Clean up supplier references and inventory record
    await c_suppliers.update_many({}, {"$pull": {"typeIds": type_id}})
    await c_inventory.delete_one({"_id": type_id})
    await c_part_types.delete_one({"_id": type_id})
    return {"ok": True}

# Purchases
@app.get("/purchases")
async def list_purchases():
    docs = [x async for x in c_purchases.find({"archived": {"$ne": True}}).sort("date", -1)]
    for d in docs: d.pop("_id", None)
    return docs

@app.post("/purchases")
async def add_purchase(p: Purchase):
    total = sum([float(it.qty) * float(it.unitCost) for it in p.items])
    doc = ensure_id(p.model_dump())
    doc["total"] = total
    # Auto mark as paid from balance
    doc["paidFromBalance"] = True
    # ensure items have ids
    for it in doc["items"]:
        if not it.get("id"):
            it["id"] = str(ObjectId())
    # initialize additionalCosts if not present
    if "additionalCosts" not in doc or doc["additionalCosts"] is None:
        doc["additionalCosts"] = []
    await c_purchases.insert_one(doc)
    # Automatically create balance entry for the purchase
    try:
        is_service = doc.get("isService", False) or any(item.get("isService", False) for item in doc.get("items", []))
        def fmt_item(it):
            name = "послуга" if (it.get("isService") or it.get("partTypeId") in (None, "")) else "позиція"
            qty = float(it.get("qty", 0))
            unit_cost = float(it.get("unitCost", 0))
            line_total = qty * unit_cost if not (it.get("isService") or qty == 0) else unit_cost
            note = it.get("note")
            base = f"{name}: {qty:.0f} × {unit_cost:.2f} = {line_total:.2f}"
            return f"{base}{f' ({note})' if note else ''}"
        details = ", ".join([fmt_item(it) for it in doc.get("items", [])])
        base_note = (f"Оплата сервісу" if is_service else "Оплата закупки")
        vendor_text = doc.get('vendor') or '(без постачальника)'
        full_note = f"{base_note} {vendor_text} — {details}" if details else f"{base_note} {vendor_text}"

        entry = {
            "id": str(ObjectId()),
            "_id": None,
            "date": doc.get("date") or now_iso(),
            "type": "purchase",
            "amount": float(doc.get("total", 0)),
            "note": full_note,
            "tag": "Покупка",
            "refPurchaseId": doc["id"],
        }
        entry["_id"] = entry["id"]
        await c_balance.insert_one(entry)
    except Exception:
        # best-effort; do not block purchase creation
        pass
    doc.pop("_id", None)
    return doc

class UpdatePurchaseRequest(BaseModel):
    date: Optional[str] = None
    vendor: Optional[str] = None
    items: Optional[List[PurchaseItem]] = None
    additionalCosts: Optional[List[AdditionalCost]] = None
    delivered: Optional[bool] = None
    paidFromBalance: Optional[bool] = None
    isService: Optional[bool] = None

@app.put("/purchases/{purchase_id}")
async def update_purchase(purchase_id: str, body: UpdatePurchaseRequest):
    p = await c_purchases.find_one({"_id": purchase_id})
    if not p:
        raise HTTPException(404, "Purchase not found")
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    # Recompute total if items or additionalCosts changed
    if "items" in patch or "additionalCosts" in patch:
        items = patch.get("items", p.get("items", []))
        add_costs = patch.get("additionalCosts", p.get("additionalCosts", []))
        items_total = sum([float(it.qty if isinstance(it, PurchaseItem) else it.get("qty", 0)) * float(it.unitCost if isinstance(it, PurchaseItem) else it.get("unitCost", 0)) for it in items])
        costs_total = sum([float(c.amount if isinstance(c, AdditionalCost) else c.get("amount", 0)) for c in add_costs])
        patch["total"] = items_total + costs_total
        # Normalize embedded objects to dicts
        def normalize_items(arr):
            out = []
            for it in arr:
                if isinstance(it, PurchaseItem):
                    d = it.model_dump()
                else:
                    d = dict(it)
                if not d.get("id"):
                    d["id"] = str(ObjectId())
                out.append(d)
            return out
        if "items" in patch:
            patch["items"] = normalize_items(items)
        if "additionalCosts" in patch:
            patch["additionalCosts"] = [
                {"id": x.get("id") or str(ObjectId()), "amount": float(x.get("amount", 0)), "description": x.get("description", ""), "date": x.get("date") or now_iso()} for x in ( [c.model_dump() if isinstance(c, AdditionalCost) else c for c in add_costs] )
            ]
    await c_purchases.update_one({"_id": purchase_id}, {"$set": patch})
    # Ensure consistency by rebuilding inventory/stock if impactful fields changed
    if any(k in patch for k in ("items", "additionalCosts", "delivered", "isService")):
        await rebuild_inventory_and_stock()
    # Always adjust balance difference when total changes
    if "total" in patch:
        diff = float(patch["total"]) - float(p.get("total", 0))
        if abs(diff) > 1e-9:
            be = {
                "id": str(ObjectId()),
                "_id": None,
                "date": patch.get("date") or p.get("date") or now_iso(),
                "type": "purchase",
                "amount": diff,
                "note": f"Корекція оплати закупки {patch.get('vendor') if isinstance(patch.get('vendor'), str) else (p.get('vendor') or '')}",
                "tag": "Покупка",
                "refPurchaseId": purchase_id,
            }
            be["_id"] = be["id"]
            await c_balance.insert_one(be)
    return {"ok": True}

@app.delete("/purchases/{purchase_id}")
async def delete_purchase(purchase_id: str):
    p = await c_purchases.find_one({"_id": purchase_id})
    if not p:
        raise HTTPException(404, "Purchase not found")
    await c_purchases.delete_one({"_id": purchase_id})
    # Also remove linked balance entries if any
    await c_balance.delete_many({"refPurchaseId": purchase_id})
    # Fallback cleanup for legacy balance entries that may not have refPurchaseId
    # Remove purchase-type balance entries on the same date without explicit ref linkage
    try:
        crit = {"type": "purchase", "refPurchaseId": {"$exists": False}, "date": p.get("date")}
        # If vendor exists, prefer narrowing by vendor mention in note
        vendor = (p.get("vendor") or "").strip()
        if vendor:
            crit["note"] = {"$regex": vendor}
        await c_balance.delete_many(crit)
    except Exception:
        # best-effort cleanup; ignore errors
        pass
    await rebuild_inventory_and_stock()
    return {"ok": True}

@app.get("/purchases/archived")
async def list_archived_purchases():
    docs = [x async for x in c_purchases.find({"archived": True}).sort("date", -1)]
    for d in docs: d.pop("_id", None)
    return docs

class ArchiveRequest(BaseModel):
    archived: bool

@app.post("/purchases/{purchase_id}/archive")
async def archive_purchase(purchase_id: str, req: ArchiveRequest):
    p = await c_purchases.find_one({"_id": purchase_id})
    if not p:
        raise HTTPException(404, "Purchase not found")
    await c_purchases.update_one({"_id": purchase_id}, {"$set": {"archived": bool(req.archived)}})
    return {"ok": True, "archived": bool(req.archived)}

@app.post("/purchases/{purchase_id}/mark-delivered")
async def mark_purchase_delivered(purchase_id: str):
    p = await c_purchases.find_one({"_id": purchase_id})
    if not p:
        raise HTTPException(404, "Purchase not found")
    if p.get("delivered"):
        return {"ok": True, "already": True}
    if p.get("isService"):
        await c_purchases.update_one({"_id": purchase_id}, {"$set": {"delivered": True}})
        return {"ok": True}
    # Prepare allocation of additional costs (by value share) only for goods (with partTypeId)
    items_total = sum([float(it.get("qty", 0)) * float(it.get("unitCost", 0)) for it in p.get("items", []) if it.get("partTypeId")])
    costs_total = sum([float(c.get("amount", 0)) for c in p.get("additionalCosts", [])])
    # Avoid division by zero
    # Map partTypeId -> extra_cost_for_entire_item_row
    extra_map: Dict[str, float] = {}
    for it in p["items"]:
        if not it.get("partTypeId"):
            continue
        base_value = float(it.get("qty", 0)) * float(it.get("unitCost", 0)) if items_total > 0 else 0.0
        share = (base_value / items_total) * costs_total if items_total > 0 else 0.0
        extra_map[it["partTypeId"]] = extra_map.get(it["partTypeId"], 0.0) + share

    # Update inventory for each item with effective unit cost including allocation
    for it in p["items"]:
        if not it.get("partTypeId"):
            continue
        qty = float(it.get("qty", 0))
        unit_cost = float(it.get("unitCost", 0))
        extra_total_for_item = extra_map.get(it["partTypeId"], 0.0)
        effective_unit_cost = unit_cost if qty <= 0 else (unit_cost + (extra_total_for_item / qty))
        await upsert_inventory(it["partTypeId"], qty, effective_unit_cost)
        # log as purchase add
        await log_stock_op("purchase", it["partTypeId"], qty, f"Закупка {p.get('vendor') or ''}")
    await c_purchases.update_one({"_id": purchase_id}, {"$set": {"delivered": True}})
    return {"ok": True}

@app.post("/purchases/{purchase_id}/pay-from-balance")
async def pay_purchase_from_balance(purchase_id: str):
    p = await c_purchases.find_one({"_id": purchase_id})
    if not p:
        raise HTTPException(404, "Purchase not found")
    if p.get("paidFromBalance"):
        return {"ok": True, "already": True}

    # Calculate total including additional costs
    items_total = sum([float(it["qty"]) * float(it["unitCost"]) for it in p["items"]])
    additional_costs = p.get("additionalCosts", [])
    costs_total = sum([float(c["amount"]) for c in additional_costs])
    total = items_total + costs_total

    # Determine if this is a service purchase
    is_service = p.get("isService", False) or any(item.get("isService", False) for item in p.get("items", []))

    # Build rich description
    def fmt_item(it):
        name = "послуга" if (it.get("isService") or it.get("partTypeId") in (None, "")) else "позиція"
        qty = float(it.get("qty", 0))
        unit_cost = float(it.get("unitCost", 0))
        line_total = qty * unit_cost if not (it.get("isService") or qty == 0) else unit_cost
        note = it.get("note")
        base = f"{name}: {qty:.0f} × {unit_cost:.2f} = {line_total:.2f}"
        return f"{base}{f' ({note})' if note else ''}"

    details = ", ".join([fmt_item(it) for it in p.get("items", [])])
    base_note = (f"Оплата сервісу" if is_service else "Оплата закупки")
    vendor_text = p.get('vendor') or '(без постачальника)'
    full_note = f"{base_note} {vendor_text} — {details}" if details else f"{base_note} {vendor_text}"

    entry = {
        "id": str(ObjectId()),
        "_id": None,
        "date": p.get("date") or now_iso(),
        "type": "purchase",
        "amount": total,
        "note": full_note,
        "tag": "Покупка",
        "refPurchaseId": purchase_id,
    }
    entry["_id"] = entry["id"]
    await c_balance.insert_one(entry)
    await c_purchases.update_one({"_id": purchase_id}, {"$set": {"paidFromBalance": True}})
    return {"ok": True}

class AddAdditionalCostRequest(BaseModel):
    amount: float
    description: str
    date: Optional[str] = None

@app.post("/purchases/{purchase_id}/add-cost")
async def add_additional_cost(purchase_id: str, req: AddAdditionalCostRequest):
    p = await c_purchases.find_one({"_id": purchase_id})
    if not p:
        raise HTTPException(404, "Purchase not found")

    # Create new additional cost entry
    cost = {
        "id": str(ObjectId()),
        "amount": float(req.amount),
        "description": req.description,
        "date": req.date or now_iso(),
    }

    # Get existing additional costs or initialize empty list
    additional_costs = p.get("additionalCosts", [])
    additional_costs.append(cost)

    # Calculate new total
    items_total = sum([float(it["qty"]) * float(it["unitCost"]) for it in p["items"]])
    costs_total = sum([float(c["amount"]) for c in additional_costs])
    new_total = items_total + costs_total

    # Update purchase
    await c_purchases.update_one(
        {"_id": purchase_id},
        {"$set": {"additionalCosts": additional_costs, "total": new_total}}
    )

    # Always add additional cost to balance
    balance_entry = {
        "id": str(ObjectId()),
        "_id": None,
        "date": cost["date"],
        "type": "purchase",
        "amount": float(req.amount),
        "note": f"Додаткові витрати ({req.description}) для закупки {p.get('vendor') or '(без постачальника)'}",
        "tag": "Покупка",
        "refPurchaseId": purchase_id,
        "refAdditionalCostId": cost["id"],
    }
    balance_entry["_id"] = balance_entry["id"]
    await c_balance.insert_one(balance_entry)

    # If purchase has already been delivered, distribute this additional
    # cost across inventory as pure value (no qty change)
    if p.get("delivered") and not p.get("isService"):
        # allocate only the newly added amount by value share
        items_total = sum([float(it["qty"]) * float(it["unitCost"]) for it in p["items"]])
        if items_total > 0 and float(req.amount) != 0:
            for it in p["items"]:
                base_value = float(it["qty"]) * float(it["unitCost"]) / items_total
                share_amount = float(req.amount) * base_value
                # add this value to the respective inventory average cost
                await add_value_to_inventory(it["partTypeId"], share_amount)
                await log_stock_op("purchase", it["partTypeId"], 0.0, f"Додаткові витрати: {req.description}")

    return {"ok": True, "cost": cost, "newTotal": new_total}

# --------- Maintenance ---------
@app.post("/maintenance/rebuild")
async def maintenance_rebuild():
    await rebuild_inventory_and_stock()
    return {"ok": True}

@app.post("/maintenance/fix-purchase-totals")
async def maintenance_fix_purchase_totals():
    """
    Recalculate all purchase totals and remove orphaned additional costs
    (those that don't have a corresponding balance entry with refAdditionalCostId).
    """
    fixed_count = 0
    async for p in c_purchases.find():
        purchase_id = p.get("_id") or p.get("id")
        items = p.get("items", [])
        additional_costs = p.get("additionalCosts", []) or []

        # Find all balance entries that reference this purchase
        balance_entries = [x async for x in c_balance.find({"refPurchaseId": purchase_id})]
        valid_cost_ids = {be.get("refAdditionalCostId") for be in balance_entries if be.get("refAdditionalCostId")}

        # Filter out orphaned costs (those without a balance entry)
        original_cost_count = len(additional_costs)
        filtered_costs = [c for c in additional_costs if c.get("id") in valid_cost_ids] if valid_cost_ids else []

        # Recalculate total
        items_total = sum([float(it.get("qty", 0)) * float(it.get("unitCost", 0)) for it in items])
        costs_total = sum([float(c.get("amount", 0)) for c in filtered_costs])
        new_total = items_total + costs_total

        # Update if anything changed
        if filtered_costs != additional_costs or abs(float(p.get("total", 0)) - new_total) > 1e-9:
            await c_purchases.update_one(
                {"_id": purchase_id},
                {"$set": {"additionalCosts": filtered_costs, "total": new_total}}
            )
            fixed_count += 1

    return {"ok": True, "fixed_count": fixed_count}

# --------- Admin updates ---------
class ToggleServiceRequest(BaseModel):
    isService: bool

@app.post("/purchases/{purchase_id}/toggle-service")
async def toggle_purchase_service(purchase_id: str, body: ToggleServiceRequest):
    p = await c_purchases.find_one({"_id": purchase_id})
    if not p:
        raise HTTPException(404, "Purchase not found")
    await c_purchases.update_one({"_id": purchase_id}, {"$set": {"isService": bool(body.isService)}})
    # Rebuild inventory/stock to ensure consistency
    await rebuild_inventory_and_stock()
    return {"ok": True, "isService": bool(body.isService)}

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
    payload = p.model_dump()
    # normalize BOM: add ids, infer classId, drop invalid/empty
    norm_bom = []
    for it in payload.get("bom", []) or []:
        d = dict(it)
        if not d.get("id"):
            d["id"] = str(ObjectId())
        pt_id = d.get("partTypeId")
        qty = float(d.get("qty", 0))
        if not pt_id or qty <= 0:
            continue
        pt = await c_part_types.find_one({"_id": pt_id})
        if not pt:
            continue
        d["classId"] = pt.get("classId")
        d["qty"] = qty
        norm_bom.append({"id": d["id"], "partTypeId": pt_id, "classId": d.get("classId"), "qty": qty})
    payload["bom"] = norm_bom
    doc = ensure_id(payload)
    await c_products.insert_one(doc)
    doc.pop("_id", None)
    # initialize stock doc if missing
    await c_product_stock.update_one(
        {"_id": doc["id"]}, {"$setOnInsert": {"id": doc["id"], "qty": 0}}, upsert=True
    )
    return doc

class UpdateProductRequest(BaseModel):
    name: Optional[str] = None
    note: Optional[str] = None
    suggestedPrice: Optional[float] = None
    bom: Optional[List[ProductBOMItem]] = None

@app.put("/products/{product_id}")
async def update_product(product_id: str, body: UpdateProductRequest):
    prod = await c_products.find_one({"_id": product_id})
    if not prod:
        raise HTTPException(404, "Product not found")
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if "bom" in patch:
        arr = patch["bom"] or []
        norm = []
        for it in arr:
            d = it.model_dump() if isinstance(it, ProductBOMItem) else dict(it)
            if not d.get("id"):
                d["id"] = str(ObjectId())
            pt_id = d.get("partTypeId")
            qty = float(d.get("qty", 0))
            if not pt_id or qty <= 0:
                continue
            pt = await c_part_types.find_one({"_id": pt_id})
            if not pt:
                continue
            cls_id = d.get("classId") or pt.get("classId")
            norm.append({"id": d["id"], "partTypeId": pt_id, "classId": cls_id, "qty": qty})
        patch["bom"] = norm
    if not patch:
        return {"ok": True}
    await c_products.update_one({"_id": product_id}, {"$set": patch})
    return {"ok": True}

@app.delete("/products/{product_id}")
async def delete_product(product_id: str):
    prod = await c_products.find_one({"_id": product_id})
    if not prod:
        raise HTTPException(404, "Product not found")
    # Block deletion if referenced in assemblies or sales
    used_in_asm = await c_assemblies.find_one({"productId": product_id})
    if used_in_asm:
        raise HTTPException(400, "Неможливо видалити: продукт використовується у збірках")
    used_in_sale = await c_sales.find_one({"productId": product_id})
    if used_in_sale:
        raise HTTPException(400, "Неможливо видалити: продукт використовується у продажах")
    await c_products.delete_one({"_id": product_id})
    await c_product_stock.delete_one({"_id": product_id})
    return {"ok": True}
# Suppliers
@app.get("/suppliers")
async def list_suppliers():
    docs = [x async for x in c_suppliers.find().sort("name", 1)]
    for d in docs: d.pop("_id", None)
    return docs

@app.post("/suppliers")
async def add_supplier(s: Supplier):
    doc = ensure_id(s.model_dump())
    # ensure link ids
    links = []
    for l in (doc.get("links") or []):
        d = dict(l)
        if not d.get("id"):
            d["id"] = str(ObjectId())
        links.append(d)
    doc["links"] = links
    await c_suppliers.insert_one(doc)
    doc.pop("_id", None)
    return doc

class UpdateSupplierRequest(BaseModel):
    name: Optional[str] = None
    website: Optional[str] = None
    links: Optional[List[SupplierLink]] = None
    classIds: Optional[List[str]] = None
    typeIds: Optional[List[str]] = None
    note: Optional[str] = None

@app.put("/suppliers/{supplier_id}")
async def update_supplier(supplier_id: str, body: UpdateSupplierRequest):
    s = await c_suppliers.find_one({"_id": supplier_id})
    if not s:
        raise HTTPException(404, "Supplier not found")
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if "links" in patch:
        norm = []
        for l in patch["links"] or []:
            d = l.model_dump() if isinstance(l, SupplierLink) else dict(l)
            if not d.get("id"):
                d["id"] = str(ObjectId())
            norm.append(d)
        patch["links"] = norm
    await c_suppliers.update_one({"_id": supplier_id}, {"$set": patch})
    return {"ok": True}

# --------- Manual stock operations ---------
class ManualStockOpRequest(BaseModel):
    classId: str
    partTypeId: str
    qty: float
    reason: str

@app.post("/stock/writeoff")
async def stock_writeoff(req: ManualStockOpRequest):
    # negative qty
    if req.qty <= 0:
        raise HTTPException(400, "qty must be > 0")
    await upsert_inventory(req.partTypeId, -float(req.qty), 0.0)
    await log_stock_op("writeoff", req.partTypeId, -float(req.qty), req.reason)
    return {"ok": True}

@app.post("/stock/replenish")
async def stock_replenish(req: ManualStockOpRequest):
    if req.qty <= 0:
        raise HTTPException(400, "qty must be > 0")
    # unit_cost unknown for manual replenish → add quantity with current avg
    cur = await c_inventory.find_one({"_id": req.partTypeId})
    avg = float(cur.get("avgCost", 0)) if cur else 0.0
    await upsert_inventory(req.partTypeId, float(req.qty), avg)
    await log_stock_op("replenish", req.partTypeId, float(req.qty), req.reason)
    return {"ok": True}

@app.get("/stock/log")
async def stock_log(page: int = 1, page_size: int = 10):
    page = max(1, int(page))
    page_size = max(1, min(100, int(page_size)))
    skip = (page - 1) * page_size
    total = await c_stock_ops.count_documents({})
    # Newest first for UX; adjust if needed
    cursor = c_stock_ops.find().sort([("_id", -1)]).skip(skip).limit(page_size)
    docs = [x async for x in cursor]
    for d in docs: d.pop("_id", None)
    return {"items": docs, "page": page, "pageSize": page_size, "total": total}

@app.delete("/suppliers/{supplier_id}")
async def delete_supplier(supplier_id: str):
    s = await c_suppliers.find_one({"_id": supplier_id})
    if not s:
        raise HTTPException(404, "Supplier not found")
    await c_suppliers.delete_one({"_id": supplier_id})
    return {"ok": True}

# Assembly
class AssemblyRequest(BaseModel):
    productId: str
    qty: int
    date: Optional[str] = None

@app.post("/assembly/start")
async def assembly_start(req: AssemblyRequest):
    product = await c_products.find_one({"_id": req.productId})
    if not product:
        raise HTTPException(404, "Product not found")
    q = int(req.qty)
    if q <= 0:
        raise HTTPException(400, "qty must be > 0")
    # Check inventory / status
    for b in product["bom"]:
        pt = await c_part_types.find_one({"_id": b.get("partTypeId")})
        unit = (pt or {}).get("unit") or "pcs"
        if unit == "pcs":
            cur = await c_inventory.find_one({"_id": b["partTypeId"]})
            have = float(cur.get("qty", 0)) if cur else 0.0
            need = float(b["qty"]) * q
            if have < need:
                raise HTTPException(400, f"Недостатньо на складі для {b['partTypeId']}: потрібно {need}, є {have}")
        else:
            status = (pt or {}).get("stockStatus") or "ok"
            if status != "ok":
                raise HTTPException(400, f"Недостатньо на складі (статус) для {b['partTypeId']}")
    # Deduct parts (take into assembly) only for pcs
    for b in product["bom"]:
        pt = await c_part_types.find_one({"_id": b.get("partTypeId")})
        unit = (pt or {}).get("unit") or "pcs"
        if unit == "pcs":
            await upsert_inventory(b["partTypeId"], -float(b["qty"]) * q, 0.0)
            await log_stock_op("assembly_use", b["partTypeId"], -float(b["qty"]) * q, f"Взято в збірку {product.get('name','')} x{q}")
        else:
            # log informational status-based consume
            await log_stock_op("assembly_use", b["partTypeId"], 0.0, f"Взято в збірку (статус) {product.get('name','')} x{q}")
    # Create assembly record with WIP status (no product stock increment yet)
    asm = {
        "id": str(ObjectId()),
        "_id": None,
        "date": req.date or now_iso(),
        "productId": req.productId,
        "qty": q,
        "status": "wip",  # Не зібрано
    }
    asm["_id"] = asm["id"]
    await c_assemblies.insert_one(asm)
    return {"ok": True, "assembly": {k: v for k, v in asm.items() if k != "_id"}}

@app.post("/assembly")
async def assemble(req: AssemblyRequest):
    product = await c_products.find_one({"_id": req.productId})
    if not product:
        raise HTTPException(404, "Product not found")
    q = int(req.qty)
    if q <= 0:
        raise HTTPException(400, "qty must be > 0")
    # Check inventory / status
    for b in product["bom"]:
        pt = await c_part_types.find_one({"_id": b.get("partTypeId")})
        unit = (pt or {}).get("unit") or "pcs"
        if unit == "pcs":
            cur = await c_inventory.find_one({"_id": b["partTypeId"]})
            have = float(cur.get("qty", 0)) if cur else 0.0
            need = float(b["qty"]) * q
            if have < need:
                raise HTTPException(400, f"Недостатньо на складі для {b['partTypeId']}: потрібно {need}, є {have}")
        else:
            status = (pt or {}).get("stockStatus") or "ok"
            if status != "ok":
                raise HTTPException(400, f"Недостатньо на складі (статус) для {b['partTypeId']}")
    # Deduct parts (only for pcs)
    for b in product["bom"]:
        pt = await c_part_types.find_one({"_id": b.get("partTypeId")})
        unit = (pt or {}).get("unit") or "pcs"
        if unit == "pcs":
            await upsert_inventory(b["partTypeId"], -float(b["qty"]) * q, 0.0)
            await log_stock_op("assembly_use", b["partTypeId"], -float(b["qty"]) * q, f"Збірка продукту {product.get('name','')} x{q}")
        else:
            await log_stock_op("assembly_use", b["partTypeId"], 0.0, f"Збірка продукту (статус) {product.get('name','')} x{q}")
    # Increase product stock
    await inc_product_stock(req.productId, q)
    # Add assembly record (legacy immediate complete)
    asm = {
        "id": str(ObjectId()),
        "_id": None,
        "date": req.date or now_iso(),
        "productId": req.productId,
        "qty": q,
        "status": "completed",
    }
    asm["_id"] = asm["id"]
    await c_assemblies.insert_one(asm)
    return {"ok": True, "assembly": {k: v for k, v in asm.items() if k != "_id"}}

@app.post("/assemblies/{assembly_id}/complete")
async def complete_assembly(assembly_id: str):
    asm = await c_assemblies.find_one({"_id": assembly_id})
    if not asm:
        raise HTTPException(404, "Assembly not found")
    if asm.get("status") == "completed":
        return {"ok": True, "already": True}
    pid = asm.get("productId")
    q = int(asm.get("qty", 0))
    if not pid or q <= 0:
        raise HTTPException(400, "Invalid assembly data")
    # Increase finished goods stock now
    await inc_product_stock(pid, q)
    await c_assemblies.update_one({"_id": assembly_id}, {"$set": {"status": "completed", "completedDate": now_iso()}})
    return {"ok": True}

# Product stock
@app.get("/product-stock")
async def list_product_stock():
    docs = [x async for x in c_product_stock.find()]
    for d in docs: d.pop("_id", None)
    return docs

# Sales
@app.get("/sales")
async def list_sales():
    docs = [x async for x in c_sales.find({"archived": {"$ne": True}}).sort("date", -1)]
    for d in docs: d.pop("_id", None)
    return docs

class SaleRequest(BaseModel):
    productId: str
    qty: int
    pricePerUnit: float
    date: Optional[str] = None
    customer: Optional[str] = ""
    note: Optional[str] = ""
    taxExempt: Optional[bool] = False

@app.post("/sales")
async def create_sale(req: SaleRequest):
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
        "taxExempt": bool(req.taxExempt or False),
        # order lifecycle flags
        "paid": False,
        "allocated": False,  # products deducted from stock
        "shipped": False,
        "completed": False,
        "archived": False,
    }
    sale["_id"] = sale["id"]
    await c_sales.insert_one(sale)
    return {"ok": True, "sale": {k: v for k, v in sale.items() if k != "_id"}}

class PaySaleBody(BaseModel):
    pass

@app.post("/sales/{sale_id}/pay")
async def pay_sale(sale_id: str):
    s = await c_sales.find_one({"_id": sale_id})
    if not s:
        raise HTTPException(404, "Sale not found")
    if s.get("paid"):
        return {"ok": True, "already": True}
    te = bool(s.get("taxExempt", False))
    net_amount = float(s.get("total", 0)) if te else (float(s.get("total", 0)) * 0.94)
    # enrich note with product and qty
    prod = await c_products.find_one({"_id": s.get("productId")})
    prod_name = (prod or {}).get("name") or s.get("productId")
    qty = int(s.get("qty", 0))
    be = {
        "id": str(ObjectId()),
        "_id": None,
        "date": s.get("date") or now_iso(),
        "type": "sale",
        "amount": net_amount,
        "note": f"Оплата замовлення ({'без податку' if te else 'після податку 0.94'}) — {s.get('customer') or ''}: {prod_name} × {qty}",
        "tag": "Продаж",
        "refSaleId": sale_id,
    }
    be["_id"] = be["id"]
    await c_balance.insert_one(be)
    await c_sales.update_one({"_id": sale_id}, {"$set": {"paid": True}})
    return {"ok": True}

@app.post("/sales/{sale_id}/allocate")
async def allocate_sale(sale_id: str):
    s = await c_sales.find_one({"_id": sale_id})
    if not s:
        raise HTTPException(404, "Sale not found")
    if s.get("allocated"):
        return {"ok": True, "already": True}
    pid = s.get("productId")
    q = int(s.get("qty", 0))
    stock = await c_product_stock.find_one({"_id": pid})
    have = int(stock.get("qty", 0)) if stock else 0
    if have < q:
        raise HTTPException(400, "Недостатньо готової продукції на складі для додавання до замовлення")
    await inc_product_stock(pid, -q)
    await c_sales.update_one({"_id": sale_id}, {"$set": {"allocated": True}})
    return {"ok": True}

@app.post("/sales/{sale_id}/ship")
async def ship_sale(sale_id: str):
    s = await c_sales.find_one({"_id": sale_id})
    if not s:
        raise HTTPException(404, "Sale not found")
    await c_sales.update_one({"_id": sale_id}, {"$set": {"shipped": True}})
    return {"ok": True}

@app.post("/sales/{sale_id}/complete")
async def complete_sale(sale_id: str):
    s = await c_sales.find_one({"_id": sale_id})
    if not s:
        raise HTTPException(404, "Sale not found")
    await c_sales.update_one({"_id": sale_id}, {"$set": {"completed": True}})
    return {"ok": True}

# ----- toggle OFF endpoints -----
@app.post("/sales/{sale_id}/unpay")
async def unpay_sale(sale_id: str):
    s = await c_sales.find_one({"_id": sale_id})
    if not s:
        raise HTTPException(404, "Sale not found")
    await c_sales.update_one({"_id": sale_id}, {"$set": {"paid": False}})
    # Remove linked balance entries by reference
    await c_balance.delete_many({"type": "sale", "refSaleId": sale_id})
    return {"ok": True}

@app.post("/sales/{sale_id}/unallocate")
async def unallocate_sale(sale_id: str):
    s = await c_sales.find_one({"_id": sale_id})
    if not s:
        raise HTTPException(404, "Sale not found")
    if not s.get("allocated"):
        return {"ok": True, "already": True}
    pid = s.get("productId")
    q = int(s.get("qty", 0))
    # return stock back
    await inc_product_stock(pid, q)
    await c_sales.update_one({"_id": sale_id}, {"$set": {"allocated": False}})
    return {"ok": True}

@app.get("/sales/archived")
async def list_archived_sales():
    docs = [x async for x in c_sales.find({"archived": True}).sort("date", -1)]
    for d in docs: d.pop("_id", None)
    return docs

class ArchiveSaleBody(BaseModel):
    archived: bool

@app.post("/sales/{sale_id}/archive")
async def archive_sale(sale_id: str, body: ArchiveSaleBody):
    s = await c_sales.find_one({"_id": sale_id})
    if not s:
        raise HTTPException(404, "Sale not found")
    await c_sales.update_one({"_id": sale_id}, {"$set": {"archived": bool(body.archived)}})
    return {"ok": True, "archived": bool(body.archived)}

@app.post("/sales/{sale_id}/unship")
async def unship_sale(sale_id: str):
    s = await c_sales.find_one({"_id": sale_id})
    if not s:
        raise HTTPException(404, "Sale not found")
    await c_sales.update_one({"_id": sale_id}, {"$set": {"shipped": False}})
    return {"ok": True}

@app.post("/sales/{sale_id}/uncomplete")
async def uncomplete_sale(sale_id: str):
    s = await c_sales.find_one({"_id": sale_id})
    if not s:
        raise HTTPException(404, "Sale not found")
    await c_sales.update_one({"_id": sale_id}, {"$set": {"completed": False}})
    return {"ok": True}

# ----- edit/delete -----
class UpdateSaleBody(BaseModel):
    productId: Optional[str] = None
    qty: Optional[int] = None
    pricePerUnit: Optional[float] = None
    date: Optional[str] = None
    customer: Optional[str] = None
    note: Optional[str] = None
    taxExempt: Optional[bool] = None

@app.put("/sales/{sale_id}")
async def update_sale(sale_id: str, body: UpdateSaleBody):
    s = await c_sales.find_one({"_id": sale_id})
    if not s:
        raise HTTPException(404, "Sale not found")
    if s.get("allocated"):
        raise HTTPException(400, "Неможливо редагувати: замовлення додане до замовлення (спробуйте спочатку прибрати)")
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not patch:
        return {"ok": True}
    new_qty = int(patch.get("qty", s.get("qty", 0)))
    new_price = float(patch.get("pricePerUnit", s.get("pricePerUnit", 0)))
    patch["total"] = float(new_qty) * float(new_price)
    await c_sales.update_one({"_id": sale_id}, {"$set": patch})
    return {"ok": True}

@app.delete("/sales/{sale_id}")
async def delete_sale(sale_id: str):
    s = await c_sales.find_one({"_id": sale_id})
    if not s:
        raise HTTPException(404, "Sale not found")
    if s.get("allocated"):
        raise HTTPException(400, "Неможливо видалити: спочатку приберіть зі замовлення (поверніть зі складу)")
    await c_sales.delete_one({"_id": sale_id})
    return {"ok": True}

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
    logger.info("Balance documents: %s", await c_balance.count_documents({}))
    # Звичайні індекси для сортування/запитів
    await c_purchases.create_index("date")
    await c_sales.create_index([("date", -1)])
    await c_balance.create_index([("date", -1)])
    await c_suppliers.create_index("name", unique=True)

# ---------- Static frontend (SPA) ----------
# Expect built assets in /app/static (index.html, assets/*)
static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/assets", StaticFiles(directory=str(static_dir / "assets")), name="assets")

    @app.get("/", include_in_schema=False)
    async def _root():
        return FileResponse(static_dir / "index.html")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _spa_fallback(full_path: str):
        # Serve API routes normally; this fallback is for client-side routing paths
        index_path = static_dir / "index.html"
        if index_path.exists():
            return FileResponse(index_path)
        raise HTTPException(404, "Not Found")