import React, { useEffect, useMemo, useState } from "react";
import { Package, Boxes, ShoppingCart, Wrench, Battery, Factory, Warehouse, Coins, DollarSign, Plus, Trash2, Save, Upload, Download, Settings } from "lucide-react";
import api from "./api";

/**
 * FPV Battery Inventory App (Server-backed, FastAPI+Mongo)
 * - No localStorage. Loads state from GET /state.
 * - All actions call API then refresh snapshot.
 */

const currency = (n) => (isNaN(n) ? "0.00" : Number(n).toFixed(2));
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function App() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("balance");
  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      const s = await api.getState();
      setState(s);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // dispatch mapper that mimics previous reducer API
  async function dispatch(action) {
    try {
      if (action.type === "ADD_PART_CLASS") {
        await api.addPartClass({ name: action.name });
      } else if (action.type === "ADD_PART_TYPE") {
        await api.addPartType({
          classId: action.classId,
          name: action.name,
          unit: action.unit,
          manufacturer: action.manufacturer,
          sku: action.sku,
          note: action.note,
        });
      } else if (action.type === "ADD_PURCHASE") {
        // Normalize pricing: if a row uses "total" mode, convert to unitCost = totalCost / qty
        const items = action.items.map(it => {
          const qty = Number(it.qty || 0);
          if (it.priceMode === "total") {
            const totalCost = Number(it.totalCost || 0);
            const unitCost = qty > 0 ? (totalCost / qty) : 0;
            return { partTypeId: it.partTypeId, qty, unitCost };
          } else {
            const unitCost = Number(it.unitCost || 0);
            return { partTypeId: it.partTypeId, qty, unitCost };
          }
        });
        const total = items.reduce((s, it) => s + it.qty * it.unitCost, 0);
        await api.addPurchase({ vendor: action.vendor || "", date: action.date || todayISO(), items, total });
      } else if (action.type === "MARK_PURCHASE_DELIVERED") {
        await api.markDelivered(action.purchaseId);
      } else if (action.type === "PAY_PURCHASE_FROM_BALANCE") {
        await api.payFromBalance(action.purchaseId);
      } else if (action.type === "ADD_BALANCE_ENTRY") {
        const entry = {
          date: action.date || todayISO(),
          type: action.entryType, // deposit | withdrawal
          amount: Number(action.amount || 0),
          note: action.note || "",
          tag: action.tag,
        };
        await api.addBalanceEntry(entry);
      } else if (action.type === "ADD_PRODUCT") {
        await api.addProduct({
          name: action.name,
          note: action.note,
          suggestedPrice: action.suggestedPrice ? Number(action.suggestedPrice) : undefined,
          bom: action.bom.map(b => ({ partTypeId: b.partTypeId, qty: Number(b.qty||0) })),
        });
      } else if (action.type === "ASSEMBLE_PRODUCT") {
        await api.assemble({ productId: action.productId, qty: Number(action.qty||0), date: action.date || todayISO() });
      } else if (action.type === "SELL_PRODUCT") {
        await api.sale({
          productId: action.productId,
          qty: Number(action.qty||0),
          pricePerUnit: Number(action.pricePerUnit||0),
          date: action.date || todayISO(),
          customer: action.customer || "",
          note: action.note || "",
        });
      } else if (action.type === "IMPORT_STATE" || action.type === "RESET_ALL") {
        alert("Імпорт/скидання в серверному режимі поки не підтримується. (Можемо додати окремі API під це)");
        return;
      }
      await refresh();
    } catch (e) {
      alert(String(e));
    }
  }

  useEffect(() => { refresh(); }, []);
  const balance = useMemo(() => {
    if (!state) return 0;
    return state.balanceEntries.reduce((sum, e) => {
      if (e.type === "deposit" || e.type === "sale") return sum + Number(e.amount || 0);
      if (e.type === "withdrawal" || e.type === "purchase") return sum - Number(e.amount || 0);
      return sum;
    }, 0);
  }, [state]);

  if (loading) return <div className="p-6">Завантаження…</div>;
  if (error) return <div className="p-6 text-red-600">Помилка: {error}</div>;

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="sticky top-0 z-10 bg-white border-b">
        <div className="max-w-6xl mx-auto flex items-center justify-between p-3">
          <div className="flex items-center gap-2">
            <Battery className="w-6 h-6" />
            <div className="font-semibold">FPV Batteries – Склад (Mongo)</div>
          </div>
          <nav className="flex gap-1 overflow-x-auto">
            <TabBtn icon={Coins} id="balance" tab={tab} setTab={setTab}>Баланс</TabBtn>
            <TabBtn icon={Package} id="parts" tab={tab} setTab={setTab}>Види деталей</TabBtn>
            <TabBtn icon={ShoppingCart} id="purchases" tab={tab} setTab={setTab}>Закупки</TabBtn>
            <TabBtn icon={Warehouse} id="inventory" tab={tab} setTab={setTab}>Склад</TabBtn>
            <TabBtn icon={Boxes} id="products" tab={tab} setTab={setTab}>Продукти (BOM)</TabBtn>
            <TabBtn icon={Factory} id="assembly" tab={tab} setTab={setTab}>Збірка</TabBtn>
            <TabBtn icon={DollarSign} id="sales" tab={tab} setTab={setTab}>Продажі</TabBtn>
            <TabBtn icon={Settings} id="settings" tab={tab} setTab={setTab}>Налаштування</TabBtn>
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 space-y-6">
        {tab === "balance" && <BalanceView state={state} dispatch={dispatch} balance={balance} />}
        {tab === "parts" && <PartsView state={state} dispatch={dispatch} />}
        {tab === "purchases" && <PurchasesView state={state} dispatch={dispatch} />}
        {tab === "inventory" && <InventoryView state={state} />}
        {tab === "products" && <ProductsView state={state} dispatch={dispatch} />}
        {tab === "assembly" && <AssemblyView state={state} dispatch={dispatch} />}
        {tab === "sales" && <SalesView state={state} dispatch={dispatch} />}
        {tab === "settings" && <SettingsView state={state} dispatch={dispatch} serverMode/>}
      </main>
    </div>
  );
}

function TabBtn({ icon: Icon, id, tab, setTab, children }) {
  const active = tab === id;
  return (
    <button
      onClick={() => setTab(id)}
      className={`px-3 py-2 rounded-xl flex items-center gap-2 border ${active ? "bg-gray-900 text-white" : "bg-white hover:bg-gray-50"}`}
    >
      <Icon className="w-4 h-4" /> {children}
    </button>
  );
}

// ---------------------- Reusable UI ----------------------
function Section({ title, icon: Icon, children, right }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2"><Icon className="w-5 h-5" /> {title}</h2>
        <div>{right}</div>
      </div>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}
function Stat({ label, value, icon: Icon }) {
  return (
    <div className="p-4 rounded-2xl shadow bg-white border flex items-center justify-between">
      <div>
        <div className="text-sm text-gray-500">{label}</div>
        <div className="text-2xl font-semibold">{value}</div>
      </div>
      {Icon && <Icon className="w-8 h-8" />}
    </div>
  );
}
function Tag({ children }) { return <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 border">{children}</span>; }
function Table({ columns, rows, empty = "Немає даних" }) {
  return (
    <div className="overflow-x-auto border rounded-2xl bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50">
          <tr>{columns.map((c) => (<th key={c.key} className="text-left p-3 font-medium text-gray-700 border-b">{c.header}</th>))}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td className="p-4 text-center text-gray-500" colSpan={columns.length}>{empty}</td></tr>
          ) : rows.map((r, i) => (
            <tr key={r.id || i} className="odd:bg-white even:bg-gray-50">
              {columns.map((c) => (<td key={c.key} className="p-3 border-b align-top">{typeof c.cell === 'function' ? c.cell(r) : r[c.key]}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function NumberInput({ value, onChange, min = 0, step = "any", placeholder }) {
  return (<input type="number" className="w-full border rounded-xl px-3 py-2" value={value} onChange={(e) => onChange(e.target.value)} min={min} step={step} placeholder={placeholder} />);
}
function TextInput({ value, onChange, placeholder }) { return <input className="w-full border rounded-xl px-3 py-2" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />; }
function Select({ value, onChange, children }) { return (<select className="w-full border rounded-xl px-3 py-2 bg-white" value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>); }

// ---------------------- Views (same UI, calls dispatch) ----------------------
function BalanceView({ state, dispatch, balance }) {
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState("");
  const [type, setType] = useState("deposit");

  const cols = [
    { key: "date", header: "Дата" },
    { key: "type", header: "Тип", cell: (r) => (<div className="flex items-center gap-2"><Tag>{r.tag || r.type}</Tag></div>) },
    { key: "amount", header: "Сума", cell: (r) => (
      <span className={r.type === 'withdrawal' || r.type === 'purchase' ? 'text-red-600' : 'text-green-600'}>
        {r.type === 'withdrawal' || r.type === 'purchase' ? '-' : '+'}{currency(r.amount)}
      </span>
    ) },
    { key: "note", header: "Нотатка" },
  ];

  return (
    <Section title="Баланс" icon={Coins} right={<Stat label="Поточний баланс" value={`${currency(balance)} ₴`} icon={Coins} />}>
      <div className="grid md:grid-cols-4 gap-3">
        <Select value={type} onChange={setType}>
          <option value="deposit">Вклад на баланс</option>
          <option value="withdrawal">Виведення з балансу</option>
        </Select>
        <NumberInput value={amount} onChange={setAmount} placeholder="Сума" />
        <TextInput value={note} onChange={setNote} placeholder="Нотатка (необов'язково)" />
        <button
          className="rounded-xl bg-gray-900 text-white px-4 py-2 flex items-center justify-center gap-2"
          onClick={() => {
            if (!amount || Number(amount) <= 0) return;
            dispatch({ type: "ADD_BALANCE_ENTRY", entryType: type, amount: Number(amount), note, tag: type === 'deposit' ? 'Вклад на баланс' : 'Виведення з балансу' });
            setAmount(0); setNote("");
          }}
        >
          <Plus className="w-4 h-4" /> Додати
        </button>
      </div>
      <Table columns={cols} rows={state.balanceEntries} empty="Поки що немає рухів" />
    </Section>
  );
}

function PartsView({ state, dispatch }) {
  const [className, setClassName] = useState("");
  const [ptName, setPtName] = useState("");
  const [ptUnit, setPtUnit] = useState("pcs");
  const [ptClassId, setPtClassId] = useState(state.partClasses[0]?.id || "");
  const [ptMan, setPtMan] = useState("");
  const [ptSku, setPtSku] = useState("");
  const [ptNote, setPtNote] = useState("");

  const classCols = [{ key: "name", header: "Назва класу" }];

  const typeCols = [
    { key: "name", header: "Назва виду" },
    { key: "class", header: "Клас", cell: (r) => state.partClasses.find((c) => c.id === r.classId)?.name || "—" },
    { key: "unit", header: "Одиниця" },
    { key: "manufacturer", header: "Виробник" },
    { key: "sku", header: "SKU" },
    { key: "note", header: "Нотатка" },
  ];

  return (
    <div className="grid gap-6">
      <Section title="Класи деталей" icon={Package}>
        <div className="grid md:grid-cols-3 gap-3">
          <TextInput value={className} onChange={setClassName} placeholder="Напр., Елементи, Нікелева стрічка, 3D-друк" />
          <button
            className="rounded-xl bg-gray-900 text-white px-4 py-2 flex items-center justify-center gap-2"
            onClick={() => {
              if (!className.trim()) return;
              dispatch({ type: "ADD_PART_CLASS", name: className });
              setClassName("");
            }}
          >
            <Plus className="w-4 h-4" /> Додати клас
          </button>
        </div>
        <Table columns={classCols} rows={state.partClasses} empty="Немає класів" />
      </Section>

      <Section title="Види деталей" icon={Boxes}>
        <div className="grid md:grid-cols-6 gap-3">
          <Select value={ptClassId} onChange={setPtClassId}>
            {state.partClasses.length === 0 && <option value="">Спочатку додайте клас</option>}
            {state.partClasses.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
          </Select>
          <TextInput value={ptName} onChange={setPtName} placeholder="Напр., Tenpower 40T, Нікель 8мм" />
          <TextInput value={ptUnit} onChange={setPtUnit} placeholder="Одиниця (pcs/m/cm)" />
          <TextInput value={ptMan} onChange={setPtMan} placeholder="Виробник (необов'язково)" />
          <TextInput value={ptSku} onChange={setPtSku} placeholder="SKU (необов'язково)" />
          <TextInput value={ptNote} onChange={setPtNote} placeholder="Нотатка" />
          <div className="md:col-span-6">
            <button
              className="rounded-xl bg-gray-900 text-white px-4 py-2 flex items-center justify-center gap-2"
              onClick={() => {
                if (!ptClassId || !ptName.trim()) return;
                dispatch({ type: "ADD_PART_TYPE", classId: ptClassId, name: ptName, unit: ptUnit, manufacturer: ptMan, sku: ptSku, note: ptNote });
                setPtName(""); setPtUnit("pcs"); setPtMan(""); setPtSku(""); setPtNote("");
              }}
            >
              <Plus className="w-4 h-4" /> Додати вид деталі
            </button>
          </div>
        </div>

        <Table columns={typeCols} rows={state.partTypes} empty="Немає видів деталей" />
      </Section>
    </div>
  );
}

function PurchasesView({ state, dispatch }) {
  const [vendor, setVendor] = useState("");
  const [date, setDate] = useState(todayISO());
  const [items, setItems] = useState([]);

  const partById = (id) => state.partTypes.find((p) => p.id === id);

  // Сума форми з урахуванням режиму ціни в кожному рядку
  const total = items.reduce((s, it) => {
    const qty = Number(it.qty || 0);
    if (it.priceMode === "total") {
      return s + Number(it.totalCost || 0);
    }
    return s + qty * Number(it.unitCost || 0);
  }, 0);

  function addRow() {
    const defaultPart = state.partTypes[0]?.id || "";
    setItems((x) => [
      ...x,
      {
        tempId: Math.random().toString(36).slice(2),
        partTypeId: defaultPart,
        qty: 0,
        priceMode: "unit",  // "unit" | "total"
        unitCost: 0,        // використовується якщо priceMode === "unit"
        totalCost: 0        // використовується якщо priceMode === "total"
      }
    ]);
  }
  function updateRow(tempId, patch) {
    setItems((x) => x.map((r) => (r.tempId === tempId ? { ...r, ...patch } : r)));
  }
  function removeRow(tempId) {
    setItems((x) => x.filter((r) => r.tempId !== tempId));
  }

  const cols = [
    { key: "date", header: "Дата" },
    { key: "vendor", header: "Постачальник" },
    { key: "items", header: "Позиції", cell: (r) => (
      <div className="text-sm text-gray-700 space-y-1">
        {r.items.map((it) => (
          <div key={it.id}>• {partById(it.partTypeId)?.name || "?"}: {it.qty} × {currency(it.unitCost)} = <b>{currency(it.qty * it.unitCost)}</b></div>
        ))}
      </div>
    ) },
    { key: "total", header: "Сума" , cell: (r) => <b>{currency(r.total)}</b>},
    { key: "status", header: "Статус", cell: (r) => (
      <div className="flex gap-2 items-center">
        {r.delivered ? <Tag>Доставлено</Tag> : <Tag>В дорозі</Tag>}
        {r.paidFromBalance ? <Tag>Оплачено</Tag> : <Tag>Не оплачено</Tag>}
      </div>
    ) },
    { key: "actions", header: "Дії", cell: (r) => (
      <div className="flex gap-2">
        <button
          className={`px-3 py-1 rounded-xl border ${r.delivered ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`}
          onClick={() => !r.delivered && dispatch({ type: "MARK_PURCHASE_DELIVERED", purchaseId: r.id })}
          disabled={r.delivered}
        >Позначити доставлено</button>
        <button
          className={`px-3 py-1 rounded-xl border ${r.paidFromBalance ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`}
          onClick={() => !r.paidFromBalance && dispatch({ type: "PAY_PURCHASE_FROM_BALANCE", purchaseId: r.id })}
          disabled={r.paidFromBalance}
        >Оплатити з балансу</button>
      </div>
    ) },
  ];

  return (
    <div className="space-y-6">
      <Section title="Нова закупка" icon={ShoppingCart}>
        {state.partTypes.length === 0 ? (
          <div className="p-4 border rounded-xl bg-yellow-50">Спочатку додайте <b>Види деталей</b>.</div>
        ) : (
          <div className="grid gap-3">
            <div className="grid md:grid-cols-3 gap-3">
              <TextInput value={vendor} onChange={setVendor} placeholder="Постачальник" />
              <input type="date" className="border rounded-xl px-3 py-2" value={date} onChange={(e) => setDate(e.target.value)} />
              <div className="flex">
                <button className="rounded-xl bg-gray-900 text-white px-4 py-2 ml-auto flex items-center gap-2" onClick={addRow}><Plus className="w-4 h-4"/> Додати позицію</button>
              </div>
            </div>

            {items.length > 0 && (
              <div className="overflow-x-auto border rounded-2xl bg-white">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="p-2 text-left">Деталь</th>
                      <th className="p-2 text-left">Кількість</th>
                      <th className="p-2 text-left">Тип ціни</th>
                      <th className="p-2 text-left">Ціна</th>
                      <th className="p-2 text-left">Сума</th>
                      <th className="p-2 text-left">—</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => (
                      <tr key={row.tempId} className="odd:bg-white even:bg-gray-50">
                        <td className="p-2">
                          <select className="w-full border rounded-xl px-2 py-1 bg-white" value={row.partTypeId} onChange={(e) => updateRow(row.tempId, { partTypeId: e.target.value })}>
                            {state.partTypes.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                          </select>
                        </td>
                        <td className="p-2">
                          <NumberInput value={row.qty} onChange={(v) => updateRow(row.tempId, { qty: Number(v) })} />
                        </td>
                        <td className="p-2">
                          <select
                            className="w-full border rounded-xl px-2 py-1 bg-white"
                            value={row.priceMode}
                            onChange={(e) => updateRow(row.tempId, { priceMode: e.target.value })}
                          >
                            <option value="unit">Ціна за од.</option>
                            <option value="total">Загальна ціна</option>
                          </select>
                        </td>
                        {row.priceMode === "unit" ? (
                          <td className="p-2">
                            <NumberInput
                              value={row.unitCost}
                              onChange={(v) => updateRow(row.tempId, { unitCost: Number(v) })}
                            />
                          </td>
                        ) : (
                          <td className="p-2">
                            <NumberInput
                              value={row.totalCost}
                              onChange={(v) => updateRow(row.tempId, { totalCost: Number(v) })}
                            />
                          </td>
                        )}
                        <td className="p-2 font-medium">
                          {row.priceMode === "unit"
                            ? currency(Number(row.qty || 0) * Number(row.unitCost || 0))
                            : currency(Number(row.totalCost || 0))}
                        </td>
                        <td className="p-2">
                          <button className="p-2 rounded-lg hover:bg-gray-100" onClick={() => removeRow(row.tempId)}>
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center justify-between">
              <div className="text-lg">Разом: <b>{currency(total)}</b></div>
              <button
                className="rounded-xl bg-gray-900 text-white px-4 py-2 flex items-center gap-2"
                onClick={() => {
                  if (items.length === 0) return;
                  const valid = items.every((r) => {
                    const qty = Number(r.qty || 0);
                    if (!r.partTypeId || qty <= 0) return false;
                    if (r.priceMode === "total") {
                      return Number(r.totalCost || 0) >= 0;
                    }
                    return Number(r.unitCost || 0) >= 0;
                  });
                  if (!valid) return;
                  dispatch({ type: "ADD_PURCHASE", vendor, date, items });
                  setVendor(""); setDate(todayISO()); setItems([]);
                }}
              ><Save className="w-4 h-4" /> Зберегти закупку</button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Історія закупок" icon={ShoppingCart}>
        <Table columns={cols} rows={state.purchases} empty="Ще не додано закупок" />
      </Section>
    </div>
  );
}

function InventoryView({ state }) {
  const partById = (id) => state.partTypes.find((p) => p.id === id);
  const rows = Object.entries(state.inventory).map(([partTypeId, data]) => ({ id: partTypeId, partTypeId, ...data }));

  const cols = [
    { key: "name", header: "Деталь", cell: (r) => (
      <div>
        <div className="font-medium">{partById(r.partTypeId)?.name || "?"}</div>
        <div className="text-xs text-gray-500">Одиниця: {partById(r.partTypeId)?.unit || 'pcs'}</div>
      </div>
    ) },
    { key: "qty", header: "Кількість" },
    { key: "avgCost", header: "Сер. собівартість", cell: (r) => currency(r.avgCost) },
    { key: "total", header: "Сума", cell: (r) => currency(r.avgCost * r.qty) },
  ];

  const prodCols = [
    { key: "name", header: "Продукт" },
    { key: "qty", header: "Кількість на складі" },
  ];
  const prodRows = Object.entries(state.productStock).map(([pid, q]) => ({ id: pid, name: state.products.find((p) => p.id === pid)?.name || "?", qty: q }));

  const totalValue = rows.reduce((s, r) => s + r.qty * r.avgCost, 0);

  return (
    <div className="grid gap-6">
      <Section title="Склад деталей" icon={Warehouse} right={<Stat label="Загальна вартість деталей" value={`${currency(totalValue)} ₴`} icon={Warehouse} />}>
        <Table columns={cols} rows={rows} empty="Порожньо" />
      </Section>
      <Section title="Склад готової продукції" icon={Boxes}>
        <Table columns={prodCols} rows={prodRows} empty="Немає зібраних батарей" />
      </Section>
    </div>
  );
}

function ProductsView({ state, dispatch }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [suggestedPrice, setSuggestedPrice] = useState("");
  const [rows, setRows] = useState([]);

  function addRow() {
    const defaultPart = state.partTypes[0]?.id || "";
    setRows((x) => [...x, { id: Math.random().toString(36).slice(2), partTypeId: defaultPart, qty: 0 }]);
  }
  function updateRow(id, patch) {
    setRows((x) => x.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id) {
    setRows((x) => x.filter((r) => r.id !== id));
  }

  const partById = (id) => state.partTypes.find((p) => p.id === id);
  const cost = rows.reduce((s, r) => s + (state.inventory[r.partTypeId]?.avgCost || 0) * Number(r.qty || 0), 0);

  const prodCols = [
    { key: "name", header: "Назва" },
    { key: "bom", header: "Склад (BOM)", cell: (p) => (
      <div className="text-sm text-gray-700 space-y-1">
        {p.bom.map((b) => (<div key={b.id}>• {partById(b.partTypeId)?.name || "?"}: {b.qty}</div>))}
      </div>
    ) },
    { key: "cost", header: "Орієнт. собівартість", cell: (p) => currency(p.bom.reduce((s, b) => s + (state.inventory[b.partTypeId]?.avgCost || 0) * b.qty, 0)) },
    { key: "stock", header: "На складі", cell: (p) => state.productStock[p.id] || 0 },
  ];

  return (
    <div className="space-y-6">
      <Section title="Новий продукт (BOM)" icon={Boxes}>
        {state.partTypes.length === 0 ? (
          <div className="p-4 border rounded-xl bg-yellow-50">Спочатку додайте <b>Види деталей</b>.</div>
        ) : (
          <div className="grid gap-3">
            <div className="grid md:grid-cols-3 gap-3">
              <TextInput value={name} onChange={setName} placeholder="Напр., Батарея 6S2P Tenpower" />
              <TextInput value={note} onChange={setNote} placeholder="Нотатка" />
              <NumberInput value={suggestedPrice} onChange={setSuggestedPrice} placeholder="Рекомендована ціна, ₴" />
            </div>

            <div className="overflow-x-auto border rounded-2xl bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="p-2 text-left">Деталь</th>
                    <th className="p-2 text-left">Кількість на 1 од.</th>
                    <th className="p-2 text-left">Сер. собівартість</th>
                    <th className="p-2 text-left">Внесок у ціну</th>
                    <th className="p-2 text-left">—</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const avg = state.inventory[r.partTypeId]?.avgCost || 0;
                    const part = partById(r.partTypeId);
                    return (
                      <tr key={r.id} className="odd:bg-white even:bg-gray-50">
                        <td className="p-2">
                          <select className="w-full border rounded-xl px-2 py-1 bg-white" value={r.partTypeId} onChange={(e) => updateRow(r.id, { partTypeId: e.target.value })}>
                            {state.partTypes.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                          </select>
                          <div className="text-xs text-gray-500">Од.: {part?.unit || 'pcs'}</div>
                        </td>
                        <td className="p-2"><NumberInput value={r.qty} onChange={(v) => updateRow(r.id, { qty: Number(v) })} /></td>
                        <td className="p-2">{currency(avg)}</td>
                        <td className="p-2 font-medium">{currency(avg * Number(r.qty || 0))}</td>
                        <td className="p-2"><button className="p-2 rounded-lg hover:bg-gray-100" onClick={() => removeRow(r.id)}><Trash2 className="w-4 h-4" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between">
              <button className="rounded-xl border px-4 py-2 flex items-center gap-2 hover:bg-gray-50" onClick={addRow}><Plus className="w-4 h-4"/> Додати позицію</button>
              <div className="text-lg">Орієнт. собівартість: <b>{currency(cost)}</b></div>
            </div>

            <div className="flex">
              <button
                className="rounded-xl bg-gray-900 text-white px-4 py-2 ml-auto flex items-center gap-2"
                onClick={() => {
                  if (!name.trim() || rows.length === 0) return;
                  const valid = rows.every((r) => r.partTypeId && r.qty > 0);
                  if (!valid) return;
                  dispatch({ type: "ADD_PRODUCT", name, note, suggestedPrice, bom: rows });
                  setName(""); setNote(""); setSuggestedPrice(""); setRows([]);
                }}
              >
                <Save className="w-4 h-4" /> Зберегти продукт
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Список продуктів" icon={Boxes}>
        <Table columns={prodCols} rows={state.products} empty="Ще немає продуктів" />
      </Section>
    </div>
  );
}

function AssemblyView({ state, dispatch }) {
  const [productId, setProductId] = useState(state.products[0]?.id || "");
  const [qty, setQty] = useState(1);
  const [date, setDate] = useState(todayISO());

  const product = state.products.find((p) => p.id === productId);
  const canAssemble = React.useMemo(() => {
    if (!product) return false;
    return product.bom.every((b) => (state.inventory[b.partTypeId]?.qty || 0) >= b.qty * qty);
  }, [product, state.inventory, qty]);

  return (
    <div className="space-y-6">
      <Section title="Збірка продукту" icon={Factory}>
        {state.products.length === 0 ? (
          <div className="p-4 border rounded-xl bg-yellow-50">Спочатку створіть <b>Продукт (BOM)</b>.</div>
        ) : (
          <div className="grid md:grid-cols-4 gap-3 items-end">
            <Select value={productId} onChange={setProductId}>
              {state.products.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
            </Select>
            <NumberInput value={qty} onChange={setQty} min={1} placeholder="Кількість" />
            <input type="date" className="border rounded-xl px-3 py-2" value={date} onChange={(e) => setDate(e.target.value)} />
            <button
              className={`rounded-xl px-4 py-2 text-white ${canAssemble ? 'bg-gray-900' : 'bg-gray-400 cursor-not-allowed'}`}
              onClick={() => {
                if (!product || !canAssemble) return;
                dispatch({ type: "ASSEMBLE_PRODUCT", productId, qty: Number(qty), date });
                setQty(1);
              }}
              disabled={!canAssemble}
            >Зібрати</button>
          </div>
        )}
      </Section>

      {product && (
        <Section title="Потрібні деталі" icon={Wrench}>
          <Table
            columns={[
              { key: "name", header: "Деталь" },
              { key: "need", header: "Потрібно" },
              { key: "have", header: "Є на складі" },
            ]}
            rows={product.bom.map((b) => ({
              id: b.id,
              name: (state.partTypes.find((p) => p.id === b.partTypeId)?.name) || "?",
              need: b.qty * qty,
              have: state.inventory[b.partTypeId]?.qty || 0,
            }))}
          />
        </Section>
      )}
    </div>
  );
}

function SalesView({ state, dispatch }) {
  const [productId, setProductId] = useState(state.products[0]?.id || "");
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(0);
  const [date, setDate] = useState(todayISO());
  const [customer, setCustomer] = useState("");
  const [note, setNote] = useState("");

  const stock = state.productStock[productId] || 0;
  const canSell = qty > 0 && stock >= qty && price >= 0;

  const cols = [
    { key: "date", header: "Дата" },
    { key: "product", header: "Продукт", cell: (s) => state.products.find((p) => p.id === s.productId)?.name || "?" },
    { key: "qty", header: "К-сть" },
    { key: "price", header: "Ціна за од.", cell: (s) => currency(s.pricePerUnit) },
    { key: "total", header: "Сума", cell: (s) => <b>{currency(s.total)}</b> },
    { key: "customer", header: "Клієнт" },
    { key: "note", header: "Нотатка" },
  ];

  return (
    <div className="space-y-6">
      <Section title="Нова продажа" icon={DollarSign}>
        {state.products.length === 0 ? (
          <div className="p-4 border rounded-xl bg-yellow-50">Спочатку створіть <b>Продукт</b> та зберіть його.</div>
        ) : (
          <div className="grid md:grid-cols-6 gap-3 items-end">
            <Select value={productId} onChange={setProductId}>
              {state.products.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
            </Select>
            <NumberInput value={qty} onChange={setQty} min={1} />
            <NumberInput value={price} onChange={setPrice} min={0} placeholder="Ціна за од., ₴" />
            <input type="date" className="border rounded-xl px-3 py-2" value={date} onChange={(e) => setDate(e.target.value)} />
            <TextInput value={customer} onChange={setCustomer} placeholder="Клієнт (необов'язково)" />
            <TextInput value={note} onChange={setNote} placeholder="Нотатка" />
            <div className="md:col-span-6">
              <button
                className={`rounded-xl px-4 py-2 text-white ${canSell ? 'bg-gray-900' : 'bg-gray-400 cursor-not-allowed'}`}
                onClick={() => {
                  if (!canSell) return;
                  dispatch({ type: "SELL_PRODUCT", productId, qty: Number(qty), pricePerUnit: Number(price), date, customer, note });
                  setQty(1); setPrice(0); setCustomer(""); setNote("");
                }}
                disabled={!canSell}
              >Продати</button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Історія продажів" icon={DollarSign}>
        <Table columns={cols} rows={state.sales} empty="Продажів поки немає" />
      </Section>
    </div>
  );
}

function SettingsView({ state, dispatch, serverMode }) {
  async function exportJSON() {
    // fetch live state from server
    const s = await api.getState();
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fpv_inventory_server_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Section title="Налаштування та дані" icon={Settings}>
      <div className="flex flex-wrap gap-3">
        <button className="rounded-xl border px-4 py-2 flex items-center gap-2 hover:bg-gray-50" onClick={exportJSON}>
          <Download className="w-4 h-4" /> Експорт JSON (з сервера)
        </button>
        <button className="rounded-xl border px-4 py-2 flex items-center gap-2 cursor-not-allowed opacity-60" title="У серверному режимі імпорт ще не підключено">
          <Upload className="w-4 h-4" /> Імпорт JSON (н/д)
        </button>
        <button className="rounded-xl border px-4 py-2 flex items-center gap-2 cursor-not-allowed opacity-60" title="Скидання ще не підключено">
          <Trash2 className="w-4 h-4" /> Скинути всі дані (н/д)
        </button>
      </div>
      <div className="text-sm text-gray-500">
        Ви працюєте у <b>серверному режимі</b>: всі дані пишуться у MongoDB через FastAPI.
      </div>
    </Section>
  );
}
