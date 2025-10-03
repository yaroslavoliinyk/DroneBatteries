import React, { useEffect, useMemo, useState } from "react";
import { Package, Boxes, ShoppingCart, Wrench, BatteryFull, Factory, Warehouse, Coins, DollarSign, Plus, Trash2, Save, Upload, Download, Settings, Info, Filter, UserCog, UserRound, RotateCcw } from "lucide-react";
import api from "./api";

/**
 * FPV Battery Inventory App (Server-backed, FastAPI+Mongo)
 * - No localStorage. Loads state from GET /state.
 * - All actions call API then refresh snapshot.
 */

const currency = (n) => (isNaN(n) ? "0.00" : Number(n).toFixed(2));
const todayISO = () => new Date().toISOString().slice(0, 10);

// Color helpers for class chips
function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const m = hex.replace('#','');
  if (![3,6].includes(m.length)) return null;
  const full = m.length === 3 ? m.split('').map(c=>c+c).join('') : m;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return null;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function makeClassChipStyle(colorHex) {
  const rgb = hexToRgb(colorHex);
  if (!rgb) return undefined;
  const { r, g, b } = rgb;
  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.12)`,
    borderColor: `rgba(${r}, ${g}, ${b}, 0.35)`,
    color: `rgb(${r}, ${g}, ${b})`,
  };
}

export default function App() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("balance");
  const [group, setGroup] = useState("inventory"); // buyer | assembler | inventory | balance | settings
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

  // Merge a partial state without showing global loading screen
  function applyPartialState(patch) {
    setState((prev) => ({ ...(prev || {}), ...(patch || {}) }));
  }

  // dispatch mapper that mimics previous reducer API
  async function dispatch(action) {
    try {
      if (action.type === "ADD_PART_CLASS") {
        await api.addPartClass({ name: action.name, color: action.color });
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
            return { partTypeId: it.partTypeId, qty, unitCost, note: (it.note || "").trim() };
          } else {
            const unitCost = Number(it.unitCost || 0);
            return { partTypeId: it.partTypeId, qty, unitCost, note: (it.note || "").trim() };
          }
        });
        const total = items.reduce((s, it) => s + it.qty * it.unitCost, 0);
        await api.addPurchase({ vendor: action.vendor || "", date: action.date || todayISO(), items, total, isService: !!action.isService });
      } else if (action.type === "MARK_PURCHASE_DELIVERED") {
        await api.markDelivered(action.purchaseId);
      } else if (action.type === "PAY_PURCHASE_FROM_BALANCE") {
        await api.payFromBalance(action.purchaseId);
      } else if (action.type === "ADD_ADDITIONAL_COST") {
        const res = await api.addAdditionalCost(action.purchaseId, {
          amount: Number(action.amount),
          description: action.description,
          date: action.date || todayISO(),
        });
        // Optimistic local update for the purchase row (no global refresh)
        applyPartialState({
          purchases: (state?.purchases || []).map((p) =>
            p.id === action.purchaseId
              ? {
                  ...p,
                  additionalCosts: [ ...(p.additionalCosts || []), res?.cost || { amount: Number(action.amount), description: action.description, date: action.date || todayISO() } ],
                  total: res?.newTotal ?? (Number(p.total || 0) + Number(action.amount || 0)),
                }
              : p
          ),
        });
        // If purchase already delivered and not a service, inventory/stock may change -> refresh only those
        try {
          const updated = (state?.purchases || []).find(p => p.id === action.purchaseId);
          if (updated?.delivered && !updated?.isService) {
            const s = await api.getState();
            applyPartialState({ inventory: s.inventory, productStock: s.productStock });
          }
        } catch (_) { /* no-op */ }
        return;
      } else if (action.type === "ADD_BALANCE_ENTRY") {
        const entry = {
          date: action.date || todayISO(),
          type: action.entryType, // deposit | withdrawal
          amount: Number(action.amount || 0),
          note: action.note || "",
          tag: action.tag,
        };
        await api.addBalanceEntry(entry);
      } else if (action.type === "UPDATE_BALANCE_ENTRY") {
        await api.updateBalanceEntry(action.id, {
          date: action.date,
          type: action.entryType,
          amount: action.amount != null ? Number(action.amount) : undefined,
          note: action.note,
          tag: action.tag,
        });
        // Optimistic local update
        applyPartialState({ balanceEntries: (state?.balanceEntries||[]).map(e => e.id === action.id ? {
          ...e,
          date: action.date ?? e.date,
          type: action.entryType ?? e.type,
          amount: action.amount != null ? Number(action.amount) : e.amount,
          note: action.note ?? e.note,
          tag: action.tag ?? e.tag,
        } : e) });
        // background refresh for balance-dependent UI
        try { const s = await api.getState(); applyPartialState({ balanceEntries: s.balanceEntries }); } catch(_){}
        return;
      } else if (action.type === "DELETE_BALANCE_ENTRY") {
        await api.deleteBalanceEntry(action.id);
        // Optimistic local removal
        applyPartialState({ balanceEntries: (state?.balanceEntries||[]).filter(e => e.id !== action.id) });
        // background refresh (state + purchases/inventory may change due to linked additionalCosts deletion)
        try { const s = await api.getState(); applyPartialState({ ...s }); } catch(_){}
        return;
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
        <div className="max-w-[110rem] mx-auto flex items-center justify-between p-3">
          <button className="flex items-center gap-3 group" onClick={() => { setGroup("inventory"); setTab("inventory"); }}>
            <img src="/photo_2024-10-10_14-01-19.jpg" alt="NEBO" className="h-6 w-6 object-cover rounded" />
            <div className="font-semibold group-hover:underline">NEBO Warehouse</div>
          </button>
          <nav className="flex gap-1 overflow-x-auto items-center">
            <GroupTabBtn id="buyer" group={group} setGroup={setGroup} setTab={setTab}>
              <span className="flex items-center gap-2">
                <span className="inline-flex items-center">
                  <UserRound className="w-4 h-4" />
                  <DollarSign className="w-3 h-3 -ml-1 text-green-600" />
                </span>
                Закупівельник
              </span>
            </GroupTabBtn>
            <GroupTabBtn id="assembler" group={group} setGroup={setGroup} setTab={setTab}>
              <span className="flex items-center gap-2"><UserCog className="w-4 h-4" /> Збірник</span>
            </GroupTabBtn>
            <div className="w-[2px] h-8 bg-gray-300 mx-4 rounded-full shadow-sm self-center" />
            <GroupTabBtn id="inventory" group={group} setGroup={setGroup} setTab={setTab}>
              <span className="flex items-center gap-2"><Warehouse className="w-4 h-4" /> Склад</span>
            </GroupTabBtn>
            <GroupTabBtn id="balance" group={group} setGroup={setGroup} setTab={setTab}>
              <span className="flex items-center gap-2"><Coins className="w-4 h-4" /> Баланс</span>
            </GroupTabBtn>
            <GroupTabBtn id="settings" group={group} setGroup={setGroup} setTab={setTab}>
              <Settings className="w-4 h-4" />
            </GroupTabBtn>
          </nav>
        </div>
      </header>

      <div className={`max-w-[110rem] mx-auto pt-2 pr-4 pl-4 pb-4 ${(['buyer','assembler'].includes(group)) ? 'grid md:grid-cols-[200px_1fr] gap-4' : ''}`}>
        {group === 'buyer' && (
          <aside className="bg-white border rounded-2xl p-3 h-max sticky top-16">
            <div className="text-xs uppercase text-gray-500 mb-2">Закупівельник</div>
            <div className="grid gap-1">
              <TabBtn icon={ShoppingCart} id="purchases" tab={tab} setTab={setTab}>Закупки</TabBtn>
              <TabBtn icon={DollarSign} id="sales" tab={tab} setTab={setTab}>Продажі</TabBtn>
              <div className="h-[2px] bg-gray-200 my-2 rounded" />
              <TabBtn icon={Package} id="suppliers" tab={tab} setTab={setTab}>Постачальники</TabBtn>
            </div>
          </aside>
        )}
        {group === 'assembler' && (
          <aside className="bg-white border rounded-2xl p-3 h-max sticky top-16">
            <div className="text-xs uppercase text-gray-500 mb-2">Збірник</div>
            <div className="grid gap-1">
              <TabBtn icon={Factory} id="assembly" tab={tab} setTab={setTab}>Збірка</TabBtn>
              <div className="h-[2px] bg-gray-200 my-2 rounded" />
              <TabBtn icon={Package} id="parts" tab={tab} setTab={setTab}>Види деталей</TabBtn>
              <TabBtn icon={Boxes} id="products" tab={tab} setTab={setTab}>Види продуктів</TabBtn>
            </div>
          </aside>
        )}
        <main className="space-y-6">
        {tab === "balance" && <BalanceView state={state} dispatch={dispatch} balance={balance} />}
        {tab === "parts" && <PartsView state={state} dispatch={dispatch} />}
          {tab === "suppliers" && <SuppliersView state={state} refresh={refresh} />}
        {tab === "purchases" && <PurchasesView state={state} dispatch={dispatch} refresh={refresh} applyPartialState={applyPartialState} />}
        {tab === "inventory" && <InventoryView state={state} />}
        {tab === "products" && <ProductsView state={state} dispatch={dispatch} />}
        {tab === "assembly" && <AssemblyView state={state} dispatch={dispatch} />}
        {tab === "sales" && <SalesView state={state} dispatch={dispatch} />}
        {tab === "settings" && <SettingsView state={state} dispatch={dispatch} serverMode/>}
      </main>
      </div>
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
      {title ? (
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold flex items-center gap-2"><Icon className="w-5 h-5" /> {title}</h2>
          <div>{right}</div>
        </div>
      ) : null}
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
function Table({ columns, rows, empty = "Немає даних", fixed = false }) {
  return (
    <div className="overflow-x-auto border rounded-2xl bg-white">
      <table className={`min-w-full w-full text-sm ${fixed ? 'table-fixed' : ''}`}>
        <thead className="bg-gray-50">
          <tr>{columns.map((c) => (
            <th key={c.key} className={`text-left p-3 font-medium text-gray-700 border-b ${c.thClass || ''}`}>{c.header}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td className="p-4 text-center text-gray-500" colSpan={columns.length}>{empty}</td></tr>
          ) : rows.map((r, i) => (
            <tr key={r.id || i} className="odd:bg-white even:bg-gray-50">
              {columns.map((c) => (
                <td key={c.key} className={`p-3 border-b align-top break-words whitespace-normal ${c.tdClass || ''}`}>
                  {typeof c.cell === 'function' ? c.cell(r, i) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Card({ children }) { return <div className="p-4 rounded-2xl shadow bg-white border">{children}</div>; }
function SectionTitle({ icon: Icon, children }) { return (
  <h2 className="text-xl font-semibold flex items-center gap-2"><Icon className="w-5 h-5" /> {children}</h2>
); }
function NumberInput({ value, onChange, min = 0, step = "any", placeholder, className }) {
  return (<input type="number" className={`${className || 'w-full'} border rounded-xl px-3 py-2`} value={value} onChange={(e) => onChange(e.target.value)} min={min} step={step} placeholder={placeholder} />);
}
function TextInput({ value, onChange, placeholder, className }) { return <input className={`${className || 'w-full'} border rounded-xl px-3 py-2`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />; }
function Select({ value, onChange, children }) { return (<select className="w-full border rounded-xl px-3 py-2 bg-white" value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>); }

// ---------------------- Views (same UI, calls dispatch) ----------------------
function BalanceView({ state, dispatch, balance }) {
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState("");
  const [type, setType] = useState("deposit");
  const [editingId, setEditingId] = useState(null);
  const [editDate, setEditDate] = useState(todayISO());
  const [editType, setEditType] = useState("deposit");
  const [editAmount, setEditAmount] = useState(0);
  const [editNote, setEditNote] = useState("");
  const [editTag, setEditTag] = useState("");

  const cols = [
    { key: "date", header: "Дата" },
    { key: "type", header: "Тип", cell: (r) => (
      editingId === r.id ? (
        <Select value={editType} onChange={setEditType}>
          <option value="deposit">Вклад</option>
          <option value="withdrawal">Виведення</option>
          <option value="purchase">Покупка</option>
          <option value="sale">Продаж</option>
        </Select>
      ) : (
        <div className="flex items-center gap-2"><Tag>{r.tag || r.type}</Tag></div>
      )
    ) },
    { key: "amount", header: "Сума", cell: (r) => (
      editingId === r.id ? (
        <NumberInput value={editAmount} onChange={setEditAmount} />
      ) : (
        <span className={r.type === 'withdrawal' || r.type === 'purchase' ? 'text-red-600' : 'text-green-600'}>
          {r.type === 'withdrawal' || r.type === 'purchase' ? '-' : '+'}{currency(r.amount)}
        </span>
      )
    ) },
    { key: "note", header: "Нотатка", cell: (r) => (
      editingId === r.id ? (
        <TextInput value={editNote} onChange={setEditNote} />
      ) : (
        r.note || ''
      )
    ) },
    { key: "actions", header: "—", thClass: "w-40", cell: (r) => (
      editingId === r.id ? (
        <div className="flex gap-2">
          <button className="px-3 py-1 rounded-xl border text-sm bg-gray-900 text-white" onClick={() => {
            dispatch({ type: 'UPDATE_BALANCE_ENTRY', id: r.id, date: editDate, entryType: editType, amount: Number(editAmount), note: editNote, tag: editTag });
            setEditingId(null);
          }}>Зберегти</button>
          <button className="px-3 py-1 rounded-xl border text-sm hover:bg-gray-50" onClick={() => setEditingId(null)}>Скасувати</button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button className="px-3 py-1 rounded-xl border text-sm hover:bg-gray-50" onClick={() => {
            setEditingId(r.id);
            setEditDate(r.date || todayISO());
            setEditType(r.type);
            setEditAmount(Number(r.amount || 0));
            setEditNote(r.note || '');
            setEditTag(r.tag || '');
          }}>Редагувати</button>
          <button className="px-3 py-1 rounded-xl border text-sm text-red-700 hover:bg-red-50 border-red-300" onClick={() => {
            if (!confirm('Видалити транзакцію?')) return;
            dispatch({ type: 'DELETE_BALANCE_ENTRY', id: r.id });
          }}>Видалити</button>
        </div>
      )
    ) },
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
  const [classColor, setClassColor] = useState("#e5e7eb");
  const [ptName, setPtName] = useState("");
  const [ptUnit, setPtUnit] = useState("pcs");
  const [ptClassId, setPtClassId] = useState(state.partClasses[0]?.id || "");
  const [ptMan, setPtMan] = useState("");
  const [ptSku, setPtSku] = useState("");
  const [ptNote, setPtNote] = useState("");

  const classCols = [
    { key: "name", header: "Назва класу" },
    { key: "color", header: "Колір", cell: (r) => (
      <span className="inline-flex items-center gap-2">
        <span className="inline-block w-4 h-4 rounded border" style={{ backgroundColor: r.color || '#e5e7eb', borderColor: '#cbd5e1' }} />
        <span className="text-xs text-gray-500">{r.color || '—'}</span>
      </span>
    )},
  ];

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
        <div className="grid md:grid-cols-4 gap-3">
          <TextInput value={className} onChange={setClassName} placeholder="Напр., Елементи, Нікелева стрічка, 3D-друк" />
          <div className="flex items-center gap-2 border rounded-xl px-3 py-2 bg-white">
            <span className="text-sm text-gray-600">Колір</span>
            <input type="color" className="w-8 h-6 p-0 border-0 bg-transparent cursor-pointer" value={classColor} onChange={(e)=> setClassColor(e.target.value)} />
          </div>
          <button
            className="rounded-xl bg-gray-900 text-white px-4 py-2 flex items-center justify-center gap-2"
            onClick={() => {
              if (!className.trim()) return;
              dispatch({ type: "ADD_PART_CLASS", name: className, color: classColor });
              setClassName(""); setClassColor("#e5e7eb");
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

function SuppliersView({ state, refresh }) {
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [note, setNote] = useState("");
  const [links, setLinks] = useState([]);
  const [classIds, setClassIds] = useState([]);
  const [typeIds, setTypeIds] = useState([]);
  const [showAdd, setShowAdd] = useState(false);

  // inline edit state
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editWebsite, setEditWebsite] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editLinks, setEditLinks] = useState([]);
  const [editClassIds, setEditClassIds] = useState([]);
  const [editTypeIds, setEditTypeIds] = useState([]);

  const classOptions = Array.isArray(state?.partClasses) ? state.partClasses : [];
  const typeOptions = Array.isArray(state?.partTypes) ? state.partTypes : [];
  const filteredTypeOptionsForAdd = classIds.length > 0
    ? typeOptions.filter(t => classIds.includes(t.classId))
    : [];

  // Keep selected typeIds consistent with chosen classes
  useEffect(() => {
    if (classIds.length === 0) {
      setTypeIds([]);
      return;
    }
    const allowed = new Set(typeOptions.filter(t => classIds.includes(t.classId)).map(t => t.id));
    setTypeIds(ids => ids.filter(id => allowed.has(id)));
  }, [classIds, typeOptions]);

  function addLink() { setLinks(x => [...x, { id: Math.random().toString(36).slice(2), title: "", url: "" }]); }
  function updateLink(id, patch) { setLinks(x => x.map(l => l.id === id ? { ...l, ...patch } : l)); }
  function removeLink(id) { setLinks(x => x.filter(l => l.id !== id)); }

  function addEditLink() { setEditLinks(x => [...x, { id: Math.random().toString(36).slice(2), title: "", url: "" }]); }
  function updateEditLink(id, patch) { setEditLinks(x => x.map(l => l.id === id ? { ...l, ...patch } : l)); }
  function removeEditLink(id) { setEditLinks(x => x.filter(l => l.id !== id)); }

  function startEditSupplier(s) {
    setEditingId(s.id);
    setEditName(s.name || "");
    setEditWebsite(s.website || "");
    setEditNote(s.note || "");
    setEditLinks((s.links || []).map(l => ({ id: l.id || Math.random().toString(36).slice(2), title: l.title || "", url: l.url || "" })));
    setEditClassIds([...(s.classIds || [])]);
    setEditTypeIds([...(s.typeIds || [])]);
  }

  async function saveEditSupplier() {
    const id = editingId;
    if (!id) return;
    try {
      await api.updateSupplier(id, {
        name: editName,
        website: editWebsite,
        note: editNote,
        links: editLinks.map(l => ({ id: l.id || Math.random().toString(36).slice(2), title: l.title || "", url: l.url || "" })),
        classIds: editClassIds,
        typeIds: editTypeIds,
      });
      setEditingId(null);
      await refresh();
    } catch (e) {
      alert(String(e));
    }
  }

  function cancelEditSupplier() {
    setEditingId(null);
  }

  async function saveSupplier() {
    if (!name.trim()) return;
    try {
      await api.addSupplier({ name, website, note, links, classIds, typeIds });
      setName(""); setWebsite(""); setNote(""); setLinks([]); setClassIds([]); setTypeIds([]);
      setShowAdd(false);
      await refresh();
    } catch (e) {
      alert(String(e));
    }
  }

  const cols = [
    { key: "name", header: "Назва", cell: (s) => editingId === s.id ? (
      <TextInput value={editName} onChange={setEditName} placeholder="Назва" />
    ) : s.name },
    { key: "website", header: "Вебсайт", cell: (s) => editingId === s.id ? (
      <TextInput value={editWebsite} onChange={setEditWebsite} placeholder="https://..." />
    ) : (s.website ? (<a className="text-blue-700 underline" href={s.website} target="_blank" rel="noreferrer">{s.website}</a>) : "—") },
    { key: "links", header: "Посилання", cell: (s) => editingId === s.id ? (
      <div className="text-sm text-gray-700 space-y-2">
        {editLinks.length === 0 && <div className="text-xs text-gray-500">Додайте посилання</div>}
        {editLinks.map(l => (
          <div key={l.id} className="grid md:grid-cols-3 gap-2">
            <TextInput value={l.title} onChange={(v)=>updateEditLink(l.id,{title:v})} placeholder="Назва (необов'язково)" />
            <TextInput value={l.url} onChange={(v)=>updateEditLink(l.id,{url:v})} placeholder="URL" />
            <button className="px-3 py-2 rounded-xl border text-sm hover:bg-gray-50" onClick={()=>removeEditLink(l.id)}>Прибрати</button>
          </div>
        ))}
        <button className="w-max px-3 py-2 rounded-xl border text-sm hover:bg-gray-50" onClick={addEditLink}>+ Додати посилання</button>
      </div>
    ) : (
      <div className="text-sm text-gray-700 space-y-1">
        {(s.links||[]).map(l => (
          <div key={l.id}>• {l.title || 'Посилання'}: <a className="text-blue-700 underline" href={l.url} target="_blank" rel="noreferrer">{l.url}</a></div>
        ))}
      </div>
    ) },
    { key: "classes", header: "Класи", cell: (s) => editingId === s.id ? (
      <div className="grid gap-2 max-h-48 overflow-auto p-2 border rounded-xl bg-white">
        {classOptions.map(c => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="scale-110" checked={editClassIds.includes(c.id)} onChange={(e)=> setEditClassIds(x => e.target.checked ? [...x, c.id] : x.filter(id=>id!==c.id)) } />
            {c.name}
          </label>
        ))}
      </div>
    ) : ((s.classIds||[]).map(id => classOptions.find(c=>c.id===id)?.name||id).join(', ') || '—') },
    { key: "types", header: "Види", cell: (s) => editingId === s.id ? (
      <div className="grid gap-2 max-h-48 overflow-auto p-2 border rounded-xl bg-white">
        {typeOptions.map(t => (
          <label key={t.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="scale-110" checked={editTypeIds.includes(t.id)} onChange={(e)=> setEditTypeIds(x => e.target.checked ? [...x, t.id] : x.filter(id=>id!==t.id)) } />
            {t.name}
          </label>
        ))}
      </div>
    ) : ((s.typeIds||[]).map(id => typeOptions.find(t=>t.id===id)?.name||id).join(', ') || '—') },
    { key: "note", header: "Нотатка", cell: (s) => editingId === s.id ? (
      <TextInput value={editNote} onChange={setEditNote} placeholder="Нотатка" />
    ) : (s.note || '') },
    { key: "actions", header: "—", thClass: "w-44", cell: (s) => (
      <div className="flex gap-2 flex-wrap">
        {editingId === s.id ? (
          <>
            <button className="px-3 py-1 rounded-xl border text-sm bg-gray-900 text-white" onClick={saveEditSupplier}>Зберегти</button>
            <button className="px-3 py-1 rounded-xl border text-sm hover:bg-gray-50" onClick={cancelEditSupplier}>Скасувати</button>
          </>
        ) : (
          <>
            <button className="px-3 py-1 rounded-xl border text-sm hover:bg-gray-50" onClick={()=> startEditSupplier(s)}>Редагувати</button>
            <button
              className="px-3 py-1 rounded-xl border text-sm text-red-700 hover:bg-red-50 border-red-300"
              onClick={async () => { if (!confirm('Видалити постачальника?')) return; await api.deleteSupplier(s.id); await refresh(); }}
            >Видалити</button>
          </>
        )}
      </div>
    ) },
  ];

  return (
    <div className="space-y-6">
      <Section
        title="Постачальники"
        icon={Package}
        right={(
          <button
            className="rounded-xl border px-4 py-2 flex items-center gap-2 hover:bg-gray-50"
            onClick={() => setShowAdd(v => !v)}
          >
            <Plus className="w-4 h-4" /> {showAdd ? 'Сховати' : 'Додати постачальника'}
          </button>
        )}
      >
        {showAdd && (
          <div className="grid gap-3">
            <div className="grid md:grid-cols-3 gap-3">
              <TextInput value={name} onChange={setName} placeholder="Назва" />
              <TextInput value={website} onChange={setWebsite} placeholder="Вебсайт (https://...)" />
              <TextInput value={note} onChange={setNote} placeholder="Нотатка" />
            </div>
            <div className="grid gap-2">
              <div className="text-sm font-medium">Посилання</div>
              {links.length === 0 && <div className="text-xs text-gray-500">Додайте посилання</div>}
              {links.map(l => (
                <div key={l.id} className="grid md:grid-cols-3 gap-2">
                  <TextInput value={l.title} onChange={(v)=>updateLink(l.id,{title:v})} placeholder="Назва (необов'язково)" />
                  <TextInput value={l.url} onChange={(v)=>updateLink(l.id,{url:v})} placeholder="URL" />
                  <button className="px-3 py-2 rounded-xl border text-sm hover:bg-gray-50" onClick={()=>removeLink(l.id)}>Прибрати</button>
                </div>
              ))}
              <button className="w-max px-3 py-2 rounded-xl border text-sm hover:bg-gray-50" onClick={addLink}>+ Додати посилання</button>
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-gray-500 mb-1">Класи товарів</div>
                <div className="grid gap-2 max-h-48 overflow-auto p-2 border rounded-xl bg-white">
                  {classOptions.map(c => (
                    <label key={c.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="scale-110" checked={classIds.includes(c.id)} onChange={(e)=> setClassIds(x => e.target.checked ? [...x, c.id] : x.filter(id=>id!==c.id)) } />
                      {c.name}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Види товарів</div>
                {classIds.length === 0 ? (
                  <div className="text-xs text-gray-500 p-2 border rounded-xl bg-white">— спочатку оберіть клас(и)</div>
                ) : (
                  <div className="grid gap-2 max-h-48 overflow-auto p-2 border rounded-xl bg-white">
                    {filteredTypeOptionsForAdd.map(t => (
                      <label key={t.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="scale-110" checked={typeIds.includes(t.id)} onChange={(e)=> setTypeIds(x => e.target.checked ? [...x, t.id] : x.filter(id=>id!==t.id)) } />
                        {t.name}
                      </label>
                    ))}
                    {filteredTypeOptionsForAdd.length === 0 && (
                      <div className="text-xs text-gray-500">— для вибраних класів немає видів</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <button className="rounded-xl bg-gray-900 text-white px-4 py-2 ml-auto flex items-center gap-2" onClick={saveSupplier}><Save className="w-4 h-4"/> Зберегти постачальника</button>
              <button className="rounded-xl border px-4 py-2 hover:bg-gray-50" onClick={()=>{ setShowAdd(false); }}>Скасувати</button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Список постачальників" icon={Package}>
        <Table columns={cols} rows={Array.isArray(state?.suppliers) ? state.suppliers : []} empty="Постачальників ще немає" />
      </Section>
    </div>
  );
}

function PurchasesView({ state, dispatch, refresh, applyPartialState }) {
  const [vendorId, setVendorId] = useState("");
  const [date, setDate] = useState(todayISO());
  const [items, setItems] = useState([]);
  const [isService, setIsService] = useState(false);
  const [expandedPurchase, setExpandedPurchase] = useState(null);
  const [costAmount, setCostAmount] = useState("");
  const [costDescription, setCostDescription] = useState("");
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierWebsite, setNewSupplierWebsite] = useState("");
  const [newSupplierForPurchaseId, setNewSupplierForPurchaseId] = useState(null);
  // Filters & sorting
  const [deliveryFilter, setDeliveryFilter] = useState("all"); // all | delivered | not_delivered
  const [paymentFilter, setPaymentFilter] = useState("all");   // all | paid | not_paid
  const [serviceFilter, setServiceFilter] = useState("all");   // all | services | goods
  const [classFilter, setClassFilter] = useState("");          // classId | ""
  const [typeFilter, setTypeFilter] = useState("");            // typeId | ""
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortBy, setSortBy] = useState("date");                // date | total | vendor
  const [sortDir, setSortDir] = useState("desc");              // asc | desc
  const [showFilters, setShowFilters] = useState(false);
  const [vendorQuery, setVendorQuery] = useState("");
  const [minTotal, setMinTotal] = useState("");
  const [maxTotal, setMaxTotal] = useState("");
  const [page, setPage] = useState(1);
  const PER_PAGE = 20;

  // inline edit state for a single row
  const [editingId, setEditingId] = useState(null);
  const [editVendor, setEditVendor] = useState("");
  const [editDate, setEditDate] = useState(todayISO());
  const [editItems, setEditItems] = useState([]);
  const [editCosts, setEditCosts] = useState([]);

  function startEditRow(p) {
    setEditingId(p.id);
    setEditVendor(p.vendor || "");
    setEditDate(p.date || todayISO());
    setEditItems(p.items.map(it => ({ id: it.id, partTypeId: it.partTypeId, qty: Number(it.qty||0), unitCost: Number(it.unitCost||0), note: it.note || "" })));
    setEditCosts((p.additionalCosts || []).map(c => ({ id: c.id, description: c.description || "", amount: Number(c.amount||0), date: c.date || todayISO() })));
  }
  async function saveEditRow() {
    const id = editingId;
    if (!id) return;
    // optimistic UI: apply local edits and exit edit mode immediately
    applyPartialState({
      purchases: state.purchases.map(p => p.id === id ? {
        ...p,
        vendor: editVendor,
        date: editDate,
        items: editItems.map(it => ({ ...it })),
        additionalCosts: editCosts.map(c => ({ ...c })),
      } : p)
    });
    setEditingId(null);
    try {
      await api.updatePurchase(id, { vendor: editVendor, date: editDate, items: editItems, additionalCosts: editCosts });
      // also refresh inventory/stock snapshot in background
      const s = await api.getState();
      applyPartialState({ inventory: s.inventory, productStock: s.productStock });
    } catch (e) {
      // fallback to server truth on error
      const s = await api.getState();
      applyPartialState({ purchases: s.purchases, inventory: s.inventory, productStock: s.productStock });
      alert(String(e));
    }
  }
  function cancelEditRow() {
    setEditingId(null);
  }

  function addCostRow() {
    setEditCosts(x => [...x, { id: Math.random().toString(36).slice(2), description: "", amount: 0, date: todayISO() }]);
  }
  function updateCostRow(id, patch) {
    setEditCosts(x => x.map(c => c.id === id ? { ...c, ...patch } : c));
  }
  function removeCostRow(id) {
    setEditCosts(x => x.filter(c => c.id !== id));
  }

  const partById = (id) => state.partTypes.find((p) => p.id === id);

  function calcTotals(p) {
    const itemsTotal = p.items.reduce((s, it) => s + Number(it.qty || 0) * Number(it.unitCost || 0), 0);
    const additionalCosts = p.additionalCosts || [];
    const costsTotal = additionalCosts.reduce((s, c) => s + Number(c.amount || 0), 0);
    return { itemsTotal, costsTotal, total: itemsTotal + costsTotal };
  }

  const filteredPurchases = useMemo(() => {
    let rows = state.purchases;

    // Status filters (services are considered delivered for filtering purposes)
    rows = rows.filter((r) => {
      const deliveredForFilter = r.isService ? true : !!r.delivered;
      if (deliveryFilter === "delivered" && !deliveredForFilter) return false;
      if (deliveryFilter === "not_delivered" && deliveredForFilter) return false;
      if (paymentFilter === "paid" && !r.paidFromBalance) return false;
      if (paymentFilter === "not_paid" && r.paidFromBalance) return false;
      if (serviceFilter === "services" && !r.isService) return false;
      if (serviceFilter === "goods" && r.isService) return false;
      return true;
    });

    // Date range
    rows = rows.filter((r) => {
      if (dateFrom && String(r.date) < dateFrom) return false;
      if (dateTo && String(r.date) > dateTo) return false;
      return true;
    });

    // Class / type filters (match if purchase contains at least one item from selected)
    if (classFilter) {
      rows = rows.filter((r) => r.items.some((it) => partById(it.partTypeId)?.classId === classFilter));
    }
    if (typeFilter) {
      rows = rows.filter((r) => r.items.some((it) => it.partTypeId === typeFilter));
    }

    // Vendor search
    if (vendorQuery.trim()) {
      const q = vendorQuery.trim().toLowerCase();
      rows = rows.filter((r) => (r.vendor || "").toLowerCase().includes(q));
    }

    // Total range
    if (minTotal !== "" || maxTotal !== "") {
      rows = rows.filter((r) => {
        const t = calcTotals(r).total;
        if (minTotal !== "" && t < Number(minTotal)) return false;
        if (maxTotal !== "" && t > Number(maxTotal)) return false;
        return true;
      });
    }

    // Sorting
    const dir = sortDir === "asc" ? 1 : -1;
    const sorted = [...rows].sort((a, b) => {
      if (sortBy === "date") {
        const av = String(a.date || ""), bv = String(b.date || "");
        return av === bv ? 0 : (av > bv ? 1 : -1) * dir;
      }
      if (sortBy === "vendor") {
        const av = String(a.vendor || "").toLowerCase();
        const bv = String(b.vendor || "").toLowerCase();
        return av === bv ? 0 : (av > bv ? 1 : -1) * dir;
      }
      // total
      const at = calcTotals(a).total;
      const bt = calcTotals(b).total;
      return at === bt ? 0 : (at > bt ? 1 : -1) * dir;
    });
    return sorted;
  }, [state.purchases, deliveryFilter, paymentFilter, serviceFilter, classFilter, typeFilter, dateFrom, dateTo, vendorQuery, minTotal, maxTotal, sortBy, sortDir]);

  const activeFilters = useMemo(() => {
    const chips = [];
    if (deliveryFilter === "delivered") chips.push("Доставлені");
    if (deliveryFilter === "not_delivered") chips.push("В дорозі");
    if (paymentFilter === "paid") chips.push("Оплачені");
    if (paymentFilter === "not_paid") chips.push("Не оплачені");
    if (serviceFilter === "services") chips.push("Послуги");
    if (serviceFilter === "goods") chips.push("Товари");
    if (classFilter) {
      const name = state.partClasses.find((c) => c.id === classFilter)?.name || classFilter;
      chips.push(`Клас: ${name}`);
    }
    if (typeFilter) {
      const name = state.partTypes.find((t) => t.id === typeFilter)?.name || typeFilter;
      chips.push(`Вид: ${name}`);
    }
    if (dateFrom) chips.push(`З: ${dateFrom}`);
    if (dateTo) chips.push(`По: ${dateTo}`);
    if (vendorQuery.trim()) chips.push(`Постачальник: "${vendorQuery.trim()}"`);
    if (minTotal !== "") chips.push(`Сума ≥ ${Number(minTotal).toFixed(2)}`);
    if (maxTotal !== "") chips.push(`Сума ≤ ${Number(maxTotal).toFixed(2)}`);
    return chips;
  }, [deliveryFilter, paymentFilter, serviceFilter, classFilter, typeFilter, dateFrom, dateTo, vendorQuery, minTotal, maxTotal, state.partClasses, state.partTypes]);
  const activeFiltersCount = activeFilters.length;

  // Reset page to 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [deliveryFilter, paymentFilter, serviceFilter, classFilter, typeFilter, dateFrom, dateTo, vendorQuery, minTotal, maxTotal, sortBy, sortDir]);

  // URL sync (read on mount)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const get = (k, def) => params.get(k) ?? def;
    setDeliveryFilter(get('df', 'all'));
    setPaymentFilter(get('pf', 'all'));
    setServiceFilter(get('sf', 'all'));
    setClassFilter(get('cf', ''));
    setTypeFilter(get('tf', ''));
    setDateFrom(get('from', ''));
    setDateTo(get('to', ''));
    setSortBy(get('sb', 'date'));
    setSortDir(get('sd', 'desc'));
    setVendorQuery(get('vq', ''));
    setMinTotal(get('min', ''));
    setMaxTotal(get('max', ''));
    setPage(Number(get('p', '1')) || 1);
    const any = ['df','pf','sf','cf','tf','from','to','sb','sd','vq','min','max'].some(k => params.get(k));
    if (any) setShowFilters(true);
  }, []);

  // URL sync (write on change)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const setParam = (k, v, def) => {
      if (v === undefined || v === null || v === '' || v === def) params.delete(k); else params.set(k, String(v));
    };
    setParam('df', deliveryFilter, 'all');
    setParam('pf', paymentFilter, 'all');
    setParam('sf', serviceFilter, 'all');
    setParam('cf', classFilter, '');
    setParam('tf', typeFilter, '');
    setParam('from', dateFrom, '');
    setParam('to', dateTo, '');
    setParam('sb', sortBy, 'date');
    setParam('sd', sortDir, 'desc');
    setParam('vq', vendorQuery, '');
    setParam('min', minTotal, '');
    setParam('max', maxTotal, '');
    setParam('p', page, '1');
    const qs = params.toString();
    const url = qs ? `${location.pathname}?${qs}` : location.pathname;
    window.history.replaceState(null, '', url);
  }, [deliveryFilter, paymentFilter, serviceFilter, classFilter, typeFilter, dateFrom, dateTo, sortBy, sortDir, vendorQuery, minTotal, maxTotal, page]);

  // Clamp page if filtered result shrinks
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredPurchases.length / PER_PAGE));
    if (page > totalPages) setPage(totalPages);
  }, [filteredPurchases.length]);

  const totalPages = Math.max(1, Math.ceil(filteredPurchases.length / PER_PAGE));
  const pageStartIndex = filteredPurchases.length === 0 ? 0 : (page - 1) * PER_PAGE + 1;
  const pageEndIndex = Math.min(filteredPurchases.length, page * PER_PAGE);
  const pageRows = filteredPurchases.slice((page - 1) * PER_PAGE, (page - 1) * PER_PAGE + PER_PAGE);

  // Сума форми з урахуванням режиму ціни в кожному рядку
  const total = items.reduce((s, it) => {
    const qty = Number(it.qty || 0);
    if (it.priceMode === "total") {
      return s + Number(it.totalCost || 0);
    }
    return s + qty * Number(it.unitCost || 0);
  }, 0);

  function addRow() {
    const defaultClass = state.partClasses[0]?.id || "";
    const defaultType = state.partTypes.find(t => t.classId === defaultClass)?.id || state.partTypes[0]?.id || "";
    setItems((x) => [
      ...x,
      {
        tempId: Math.random().toString(36).slice(2),
        classId: defaultClass,
        partTypeId: defaultType,
        qty: 0,
        priceMode: "unit",  // "unit" | "total"
        unitCost: 0,        // використовується якщо priceMode === "unit"
        totalCost: 0,       // використовується якщо priceMode === "total"
        note: ""
      }
    ]);
  }
  function updateRow(tempId, patch) {
    setItems((x) => x.map((r) => (r.tempId === tempId ? { ...r, ...patch } : r)));
  }
  function removeRow(tempId) {
    setItems((x) => x.filter((r) => r.tempId !== tempId));
  }

  const hasIncompleteRow = useMemo(() => {
    if (items.length === 0) return false;
    return items.some((r) => {
      const qty = Number(r.qty || 0);
      if (!r.partTypeId || qty <= 0) return true;
      if (r.priceMode === 'unit') return Number(r.unitCost || 0) <= 0;
      return Number(r.totalCost || 0) <= 0;
    });
  }, [items]);

  const cols = [
    { key: "idx", header: "#", thClass: "w-10", cell: (r, idx) => <span className="text-gray-500">{idx + 1}</span> },
    { key: "date", header: "Дата", thClass: "w-28" },
    { key: "vendor", header: "Постачальник", thClass: "w-44", cell: (r) => (
      editingId === r.id ? (
        <div className="flex items-center gap-2">
          <select
            className="border rounded-xl px-2 py-1 bg-white"
            value={editVendor}
            onChange={(e)=> setEditVendor(e.target.value)}
          >
            <option value="">— Постачальник —</option>
            {(state.suppliers||[]).map(s => (<option key={s.id} value={s.name}>{s.name}</option>))}
          </select>
        </div>
      ) : (
        <button className="px-2 py-0.5 rounded-full text-xs border bg-gray-50 border-gray-300 text-gray-700 hover:bg-gray-100" onClick={()=> setVendorQuery((r.vendor||"").trim())}>{r.vendor || "—"}</button>
      )
    ) },
    { key: "items", header: "Позиції", thClass: "w-[30%]", tdClass: "w-[30%]", cell: (r) => {
      const additionalCosts = r.additionalCosts || [];
      const itemsTotal = r.items.reduce((s, it) => s + Number(it.qty || 0) * Number(it.unitCost || 0), 0);
      const costsTotal = additionalCosts.reduce((s, c) => s + Number(c.amount || 0), 0);

      return (
        <div className="text-sm text-gray-700 space-y-3">
          {r.items.map((it) => {
            const part = partById(it.partTypeId);
            const partClass = part ? state.partClasses.find((c) => c.id === part.classId) : null;
            const baseValue = Number(it.qty || 0) * Number(it.unitCost || 0);
            const share = itemsTotal > 0 ? (baseValue / itemsTotal) * costsTotal : 0;
            const effectiveUnit = Number(it.qty || 0) > 0 ? (Number(it.unitCost || 0) + share / Number(it.qty || 0)) : Number(it.unitCost || 0);
            const effectiveTotal = Number(it.qty || 0) * effectiveUnit;
            const isEditing = editingId === r.id;
            return (
              <div key={it.id} className="space-y-1">
                <div>
                  <button
                    className="px-2 py-0.5 rounded-full text-xs border hover:bg-gray-50"
                    style={makeClassChipStyle(partClass?.color)}
                    onClick={()=> setClassFilter(partClass?.id || '')}
                  >{partClass?.name || "?"}</button>
                </div>
                <div>
                  <button className="px-2 py-0.5 rounded-full text-xs border bg-gray-50 border-gray-300 text-gray-800 hover:bg-gray-100" onClick={()=> setTypeFilter(part?.id || '')}>{part?.name || "?"}</button>
                </div>
                {isEditing ? (
                  <div className="flex items-center gap-2">
                    <NumberInput className="w-20" value={(editItems.find(x=>x.id===it.id)||{}).qty ?? it.qty} onChange={(v)=> setEditItems(arr=> arr.map(x=> x.id===it.id? { ...x, qty: Number(v) }: x))} />
                    <span className="text-gray-500">×</span>
                    <NumberInput className="w-20" value={(editItems.find(x=>x.id===it.id)||{}).unitCost ?? it.unitCost} onChange={(v)=> setEditItems(arr=> arr.map(x=> x.id===it.id? { ...x, unitCost: Number(v) }: x))} />
                    <span className="text-xs text-gray-500">= {currency(((editItems.find(x=>x.id===it.id)||{qty:it.qty,unitCost:it.unitCost}).qty) * ((editItems.find(x=>x.id===it.id)||{qty:it.qty,unitCost:it.unitCost}).unitCost + (share/( (editItems.find(x=>x.id===it.id)||{qty:it.qty}).qty || 1))))}</span>
                  </div>
                ) : (
                  <div><span>{it.qty} × {currency(effectiveUnit)} = <b>{currency(effectiveTotal)}</b></span></div>
                )}
              </div>
            );
          })}
        </div>
      );
    } },
    { key: "note", header: "Нотатка", thClass: "w-[34%]", cell: (r) => {
      const isEditing = editingId === r.id;
      if (isEditing) {
        return (
          <div className="text-xs text-gray-700 space-y-2">
            {(r.items || []).map((it) => (
              <div key={it.id}>
                <TextInput
                  value={(editItems.find(x=>x.id===it.id)||{}).note ?? (it.note || "")}
                  onChange={(v)=> setEditItems(arr=> arr.map(x=> x.id===it.id? { ...x, note: v }: x))}
                  placeholder="Нотатка (необов'язково)"
                />
              </div>
            ))}
          </div>
        );
      }
      const notes = (r.items || []).map(it => (it.note || '').trim()).filter(Boolean);
      if (notes.length === 0) return '—';
      return (
        <div className="text-xs text-gray-600 space-y-1">
          {notes.map((n, i) => (<div key={i}>• {n}</div>))}
        </div>
      );
    } },
    { key: "total", header: "Сума", thClass: "w-24", cell: (r) => {
      const itemsTotal = r.items.reduce((s, it) => s + Number(it.qty || 0) * Number(it.unitCost || 0), 0);
      const additionalCosts = r.additionalCosts || [];
      const costsTotal = additionalCosts.reduce((s, c) => s + Number(c.amount || 0), 0);
      const total = itemsTotal + costsTotal;

      return (
        <div>
          <div className="font-bold">{currency(total)}</div>
          {additionalCosts.length > 0 && (
            <div className="text-xs text-gray-500">
              <span>{currency(itemsTotal)}</span>
              {additionalCosts.map((c, idx) => (
                <span key={c.id || idx}> + {Number(c.amount || 0).toFixed(2)} грн {c.description || ''}</span>
              ))}
            </div>
          )}
        </div>
      );
    }},
    { key: "status", header: "Статус", thClass: "w-48", cell: (r) => (
      <div className="flex gap-2 items-center">
        {!r.isService && (
          r.delivered
            ? <button className="px-2 py-0.5 rounded-full text-xs bg-green-50 border border-green-200 text-green-700 whitespace-nowrap" onClick={()=> setDeliveryFilter('delivered')}>Доставлено</button>
            : <button className="px-2 py-0.5 rounded-full text-xs bg-rose-100 border border-rose-300 text-rose-700 whitespace-nowrap" onClick={()=> setDeliveryFilter('not_delivered')}>В дорозі</button>
        )}
        {r.paidFromBalance
          ? <button className="px-2 py-0.5 rounded-full text-xs bg-green-50 border border-green-200 text-green-700 whitespace-nowrap" onClick={()=> setPaymentFilter('paid')}>Оплачено</button>
          : <button className="px-2 py-0.5 rounded-full text-xs bg-rose-100 border border-rose-300 text-rose-700 whitespace-nowrap" onClick={()=> setPaymentFilter('not_paid')}>Не оплачено</button>}
        {r.isService && (
          <span className="px-2 py-0.5 rounded-full text-xs bg-purple-100 border border-purple-300 text-purple-800">Послуги</span>
        )}
      </div>
    ) },
    { key: "actions", header: "Дії", thClass: "w-64", cell: (r) => (
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          {!r.isService && (
            <button
              className={`px-3 py-1 rounded-xl border text-sm ${r.delivered ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`}
              onClick={() => !r.delivered && dispatch({ type: "MARK_PURCHASE_DELIVERED", purchaseId: r.id })}
              disabled={r.delivered}
            >Позначити доставлено</button>
          )}
          <button
            className={`px-3 py-1 rounded-xl border text-sm ${r.paidFromBalance ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`}
            onClick={() => !r.paidFromBalance && dispatch({ type: "PAY_PURCHASE_FROM_BALANCE", purchaseId: r.id })}
            disabled={r.paidFromBalance}
          >Оплатити з балансу</button>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-700">
          <input
            type="checkbox"
            className="scale-110"
            checked={!!r.isService}
            onChange={async (e) => {
              const next = e.target.checked;
              const prev = !!r.isService;
              // Оптимістичне оновлення UI конкретного рядка
              applyPartialState({ purchases: state.purchases.map(p => p.id === r.id ? { ...p, isService: next } : p) });
              try {
                await api.toggleService(r.id, next);
                // Швидко оновимо інвентар і залишки продуктів (без повного state)
                const s = await api.getState();
                applyPartialState({ inventory: s.inventory, productStock: s.productStock });
              } catch (err) {
                // Відкотимо оптимістичну зміну при помилці
                applyPartialState({ purchases: state.purchases.map(p => p.id === r.id ? { ...p, isService: prev } : p) });
                alert(String(err));
              }
            }}
          />
          Позначити як послуги
          <span
            className="inline-flex items-center cursor-pointer"
            title="не впливає на склад"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              alert("Послуги: закупка не впливає на склад. Позиції не додаються у склад, додаткові витрати не розподіляються по собівартості.");
            }}
          >
            <Info className="w-3 h-3 text-gray-500" />
          </span>
        </label>
        {!r.isService && editingId !== r.id && (
          <button
            className="px-3 py-1 rounded-xl border text-sm hover:bg-blue-50 border-blue-300 text-blue-700"
            onClick={() => setExpandedPurchase(expandedPurchase === r.id ? null : r.id)}
          >
            {expandedPurchase === r.id ? '− Сховати' : '+ Додати витрати'}
          </button>
        )}
        <div className="flex gap-2">
              {editingId === r.id ? (
            <div className="flex gap-2 flex-wrap">
              <button
                className="px-3 py-1 rounded-xl border text-sm bg-gray-900 text-white"
                onClick={saveEditRow}
              >Зберегти</button>
              <button
                className="px-3 py-1 rounded-xl border text-sm hover:bg-gray-50"
                onClick={cancelEditRow}
              >Скасувати</button>
            </div>
          ) : (
            <button
              className="px-3 py-1 rounded-xl border text-sm hover:bg-gray-50"
              onClick={() => startEditRow(r)}
            >Редагувати</button>
          )}
          <button
            className="px-3 py-1 rounded-xl border text-sm text-red-700 hover:bg-red-50 border-red-300"
            onClick={async () => {
              if (!confirm('Видалити закупку? Дію не можна скасувати.')) return;
              try {
                await api.deletePurchase(r.id);
                applyPartialState({ purchases: state.purchases.filter(p => p.id !== r.id) });
                const s = await api.getState();
                applyPartialState({ inventory: s.inventory, productStock: s.productStock });
              } catch (e) {
                alert(String(e));
              }
            }}
          >Видалити</button>
        </div>
        {expandedPurchase === r.id && !r.isService && (
          <div className="mt-2 p-3 bg-blue-50 rounded-xl space-y-2">
            {r.paidFromBalance && (
              <div className="text-xs bg-yellow-100 border border-yellow-300 rounded-lg p-2 text-yellow-800">
                ⚠️ Закупка вже оплачена. Додаткові витрати автоматично спишуться з балансу.
              </div>
            )}
            <TextInput
              value={costDescription}
              onChange={setCostDescription}
              placeholder="Опис (напр., Доставка)"
            />
            <NumberInput
              value={costAmount}
              onChange={setCostAmount}
              placeholder="Сума"
            />
            <button
              className="w-full px-3 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700"
              onClick={() => {
                if (!costDescription.trim() || !costAmount || Number(costAmount) <= 0) return;
                dispatch({
                  type: "ADD_ADDITIONAL_COST",
                  purchaseId: r.id,
                  amount: Number(costAmount),
                  description: costDescription
                });
                setCostAmount("");
                setCostDescription("");
                setExpandedPurchase(null);
              }}
            >
              <Plus className="w-4 h-4 inline mr-1" /> Додати витрати
            </button>
          </div>
        )}
      </div>
    ) },
  ];

  return (
    <div className="space-y-2">
      <Section title="" icon={ShoppingCart}>
        {state.partTypes.length === 0 ? (
          <div className="p-4 border rounded-xl bg-yellow-50">Спочатку додайте <b>Види деталей</b>.</div>
        ) : (
          <div className="grid gap-3">
            {items.length === 0 ? (
              <div className="flex items-center justify-end py-2">
                <button className="rounded-xl bg-gray-900 text-white px-5 py-3 flex items-center gap-2" onClick={addRow}>
                  <Plus className="w-4 h-4"/> Додати позицію
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <input type="date" className="border rounded-xl px-3 py-2" value={date} onChange={(e) => setDate(e.target.value)} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="scale-110" checked={isService} onChange={(e) => setIsService(e.target.checked)} />
                  Послуги
                  <span
                    className="inline-flex items-center cursor-pointer"
                    title="не впливає на склад"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      alert("Послуги: закупка не впливає на склад. Позиції не додаються у склад, додаткові витрати не розподіляються по собівартості.");
                    }}
                  >
                    <Info className="w-4 h-4 text-gray-500" />
                  </span>
                </label>
                <button
                  className={`rounded-xl px-4 py-2 ml-auto flex items-center gap-2 ${hasIncompleteRow ? 'bg-gray-400 text-white cursor-not-allowed' : 'bg-gray-900 text-white'}`}
                  onClick={() => { if (!hasIncompleteRow) addRow(); }}
                  disabled={hasIncompleteRow}
                >
                  <Plus className="w-4 h-4"/> Додати позицію
                </button>
              </div>
            )}

            {items.length > 0 && (
              <div className="overflow-x-auto border rounded-2xl bg-white">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50">
                  <tr>
                      <th className="p-2 text-left">Клас</th>
                      <th className="p-2 text-left">Деталь</th>
                      <th className="p-2 text-left">Кількість</th>
                      <th className="p-2 text-left">Тип ціни</th>
                      <th className="p-2 text-left">Ціна</th>
                      <th className="p-2 text-left">Сума</th>
                    <th className="p-2 text-left">Нотатка</th>
                      <th className="p-2 text-left">—</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => (
                      <tr key={row.tempId} className="odd:bg-white even:bg-gray-50">
                        <td className="p-2">
                          <select className="w-full border rounded-xl px-2 py-1 bg-white" value={row.classId} onChange={(e) => {
                            const nextClass = e.target.value;
                            const firstType = state.partTypes.find(t => t.classId === nextClass)?.id || "";
                            updateRow(row.tempId, { classId: nextClass, partTypeId: firstType });
                          }}>
                            {state.partClasses.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                          </select>
                        </td>
                        <td className="p-2">
                          <select className="w-full border rounded-xl px-2 py-1 bg-white" value={row.partTypeId} onChange={(e) => updateRow(row.tempId, { partTypeId: e.target.value })}>
                            {state.partTypes.filter(p => !row.classId || p.classId === row.classId).map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
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
                          <TextInput
                            value={row.note || ""}
                            onChange={(v) => updateRow(row.tempId, { note: v })}
                            placeholder="Нотатка (необов'язково)"
                          />
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

            {items.length > 0 && (
              <div className="flex items-center justify-between">
                <div className="text-lg font-semibold">{currency(total)}</div>
                <div className="flex items-center gap-3">
                  <select className="border rounded-xl px-2 py-1 bg-white" value={vendorId} onChange={(e)=> setVendorId(e.target.value)}>
                    <option value="">— Оберіть постачальника —</option>
                    {(state.suppliers||[]).map(s => (<option key={s.id} value={s.id}>{s.name}</option>))}
                  </select>
                  <button className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50" onClick={()=> setShowNewSupplier(true)}>Створити нового</button>
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
                      const vendorName = (state.suppliers||[]).find(s=>s.id===vendorId)?.name || "";
                      dispatch({ type: "ADD_PURCHASE", vendor: vendorName, date, items, isService });
                      setVendorId(""); setDate(todayISO()); setItems([]); setIsService(false);
                    }}
                  ><Save className="w-4 h-4" /> Зберегти закупку</button>
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      {showNewSupplier && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border p-4 w-full max-w-md space-y-3">
            <div className="text-lg font-semibold">Новий постачальник</div>
            <TextInput value={newSupplierName} onChange={setNewSupplierName} placeholder="Назва" />
            <TextInput value={newSupplierWebsite} onChange={setNewSupplierWebsite} placeholder="Вебсайт (https://...)" />
            <div className="flex items-center justify-end gap-2">
              <button className="rounded-xl border px-4 py-2 hover:bg-gray-50" onClick={()=> setShowNewSupplier(false)}>Скасувати</button>
              <button className="rounded-xl bg-gray-900 text-white px-4 py-2" onClick={async()=>{
                if (!newSupplierName.trim()) return;
                try {
                  const s = await api.addSupplier({ name: newSupplierName.trim(), website: newSupplierWebsite.trim() });
                  setVendorId(s.id);
                  setNewSupplierName(""); setNewSupplierWebsite(""); setShowNewSupplier(false);
                  await refresh();
                } catch(e){ alert(String(e)); }
              }}>Створити</button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-0">
        <Section
          title="Історія закупок"
        icon={ShoppingCart}
        right={(
          <div className="flex items-center gap-2">
            <button
              className={`px-3 py-2 rounded-xl border flex items-center gap-2 ${showFilters ? 'bg-gray-900 text-white' : 'bg-white hover:bg-gray-50'}`}
              onClick={() => setShowFilters((v) => !v)}
            >
              <Filter className="w-4 h-4" /> Фільтри
              {activeFiltersCount > 0 && (
                <span className="ml-1 px-2 py-0.5 rounded-full text-xs bg-gray-900 text-white">{activeFiltersCount}</span>
              )}
            </button>
            <button
              className="px-3 py-2 rounded-xl border flex items-center gap-2 bg-white hover:bg-gray-50"
              title="Скинути фільтри"
              onClick={() => {
                setDeliveryFilter("all");
                setPaymentFilter("all");
                setServiceFilter("all");
                setClassFilter("");
                setTypeFilter("");
                setDateFrom("");
                setDateTo("");
                setVendorQuery("");
                setMinTotal("");
                setMaxTotal("");
                setSortBy("date");
                setSortDir("desc");
              }}
            >
              <RotateCcw className="w-4 h-4" /> Скинути
            </button>
          </div>
        )}
      >
        {showFilters && (
          <div className="mb-3 p-3 rounded-2xl border bg-white shadow-sm space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <div className="text-xs text-gray-500 mb-1">Доставка</div>
                <Select value={deliveryFilter} onChange={(v) => setDeliveryFilter(v)}>
                  <option value="all">Всі</option>
                  <option value="delivered">Лише доставлені</option>
                  <option value="not_delivered">Лише в дорозі</option>
                </Select>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Оплата</div>
                <Select value={paymentFilter} onChange={(v) => setPaymentFilter(v)}>
                  <option value="all">Всі</option>
                  <option value="paid">Лише оплачені</option>
                  <option value="not_paid">Лише не оплачені</option>
                </Select>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Тип</div>
                <Select value={serviceFilter} onChange={(v) => setServiceFilter(v)}>
                  <option value="all">Всі</option>
                  <option value="goods">Лише товари</option>
                  <option value="services">Лише послуги</option>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="text-xs text-gray-500 mb-1">Клас</div>
                <Select value={classFilter} onChange={(v) => { setClassFilter(v); setTypeFilter(""); }}>
                  <option value="">Всі</option>
                  {state.partClasses.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Вид</div>
                <Select value={typeFilter} onChange={setTypeFilter}>
                  <option value="">{classFilter ? 'Всі в класі' : '— спочатку оберіть клас'}</option>
                  {state.partTypes
                    .filter((t) => !classFilter || t.classId === classFilter)
                    .map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                </Select>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-5 items-end">
              <div className="grid grid-cols-2 gap-3 md:col-span-3">
                <div>
                  <div className="text-xs text-gray-500 mb-1">Дата з</div>
                  <input type="date" className="w-full border rounded-xl px-3 py-2" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">Дата по</div>
                  <input type="date" className="w-full border rounded-xl px-3 py-2" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Постачальник (пошук)</div>
                <TextInput value={vendorQuery} onChange={setVendorQuery} placeholder="напр., AliExpress" />
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Сортувати за</div>
                <Select value={sortBy} onChange={setSortBy}>
                  <option value="date">Дата</option>
                  <option value="total">Сума</option>
                  <option value="vendor">Постачальник</option>
                </Select>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Напрям</div>
                <Select value={sortDir} onChange={setSortDir}>
                  <option value="desc">За спаданням</option>
                  <option value="asc">За зростанням</option>
                </Select>
              </div>

            </div>
            {activeFilters.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {activeFilters.map((txt, i) => (<Tag key={txt + i}>{txt}</Tag>))}
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-3 items-end">
              <div>
                <div className="text-xs text-gray-500 mb-1">Мін. сума</div>
                <NumberInput value={minTotal} onChange={setMinTotal} min={0} placeholder="0" />
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Макс. сума</div>
                <NumberInput value={maxTotal} onChange={setMaxTotal} min={0} placeholder="10000" />
              </div>
              <button
                className="rounded-xl border px-4 py-2 hover:bg-gray-50 md:col-span-1"
                onClick={() => {
                  setDeliveryFilter("all");
                  setPaymentFilter("all");
                  setServiceFilter("all");
                  setClassFilter("");
                  setTypeFilter("");
                  setDateFrom("");
                  setDateTo("");
                  setVendorQuery("");
                  setMinTotal("");
                  setMaxTotal("");
                  setSortBy("date");
                  setSortDir("desc");
                }}
              >Скинути</button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mb-2 text-xs text-gray-500">
          <div>
            Знайдено: {filteredPurchases.length}
            {filteredPurchases.length > 0 && (
              <span> • Показано {pageStartIndex}–{pageEndIndex}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              className={`px-2 py-1 rounded-lg border ${page <= 1 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`}
              onClick={() => page > 1 && setPage(page - 1)}
              disabled={page <= 1}
            >
              ‹ Назад
            </button>
            <span className="px-2">Стор. {page} з {totalPages}</span>
            <button
              className={`px-2 py-1 rounded-lg border ${page >= totalPages ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`}
              onClick={() => page < totalPages && setPage(page + 1)}
              disabled={page >= totalPages}
            >
              Вперед ›
            </button>
          </div>
        </div>
        <Table columns={cols} rows={pageRows} empty="Ще не додано закупок" fixed />
        {totalPages > 1 && (
          <div className="flex items-center justify-end mt-2 gap-1">
            <button
              className={`px-3 py-1 rounded-xl border text-sm ${page <= 1 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`}
              onClick={() => page > 1 && setPage(page - 1)}
              disabled={page <= 1}
            >
              ‹ Назад
            </button>
            <span className="px-2 text-xs text-gray-500">Стор. {page} з {totalPages}</span>
            <button
              className={`px-3 py-1 rounded-xl border text-sm ${page >= totalPages ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`}
              onClick={() => page < totalPages && setPage(page + 1)}
              disabled={page >= totalPages}
            >
              Вперед ›
            </button>
          </div>
        )}
        </Section>
      </div>
    </div>
  );
}

function InventoryView({ state }) {
  const partById = (id) => state.partTypes.find((p) => p.id === id);
  const rows = Object.entries(state.inventory).map(([partTypeId, data]) => ({ id: partTypeId, partTypeId, ...data }));

  const cols = [
    { key: "name", header: "Деталь", cell: (r) => {
      const part = partById(r.partTypeId);
      const partClass = part ? state.partClasses.find((c) => c.id === part.classId) : null;
      return (
        <div>
          <div className="font-medium">
            <span className="text-gray-500">[{partClass?.name || "?"}]</span> {part?.name || "?"}
          </div>
          <div className="text-xs text-gray-500">Одиниця: {part?.unit || 'pcs'}</div>
        </div>
      );
    } },
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
    setRows((x) => [...x, { id: Math.random().toString(36).slice(2), partTypeId: defaultPart, qty: 0, note: "" }]);
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
      <Section title="Новий продукт" icon={Boxes}>
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
                    <th className="p-2 text-left">Нотатка</th>
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
                        <td className="p-2"><TextInput value={r.note} onChange={(v)=> updateRow(r.id, { note: v })} placeholder="Нотатка" /></td>
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
  async function rebuild() {
    await api.rebuild();
    // Обновити снапшот після перерахунку, щоб одразу побачити зміни
    const s = await api.getState();
    // Грубо, але просто: оновимо весь state через локальний трик
    // (рефреш у батьківському компоненті вже існує, але тут робимо швидке оновлення)
    // Використаємо window.dispatchEvent, щоб не ламати структуру. Спрощено: перезавантажимо сторінку
    // якщо щось піде не так.
    try {
      // Прямого сеттера в SettingsView немає; використаємо швидкий спосіб:
      // створимо кастомну подію і перехопимо її на верхньому рівні в майбутньому, а зараз —
      // тимчасово просто перезавантажимо стан через грубий спосіб: перезавантаження сторінки.
      // Щоб уникнути повного reload, зробимо найпростіше — викличемо глобальний refresh через location.
      // Це забезпечить синхронізацію всіх вкладок без складних пропсів.
      // eslint-disable-next-line no-restricted-globals
      location.reload();
    } catch (_) {
      alert("Склад та залишки перераховано. Оновіть сторінку для відображення.");
    }
  }
  async function fixPurchaseTotals() {
    try {
      const result = await api.fixPurchaseTotals();
      alert(`Виправлено ${result.fixed_count} закупок. Сторінка оновиться.`);
      // eslint-disable-next-line no-restricted-globals
      location.reload();
    } catch (e) {
      alert(`Помилка: ${String(e)}`);
    }
  }

  return (
    <Section title="Налаштування та дані" icon={Settings}>
      <div className="flex flex-wrap gap-3">
        <button className="rounded-xl border px-4 py-2 flex items-center gap-2 hover:bg-gray-50" onClick={exportJSON}>
          <Download className="w-4 h-4" /> Експорт JSON (з сервера)
        </button>
        <button className="rounded-xl border px-4 py-2 flex items-center gap-2 hover:bg-gray-50" onClick={rebuild}>
          <Wrench className="w-4 h-4" /> Перерахувати склад
        </button>
        <button className="rounded-xl border px-4 py-2 flex items-center gap-2 hover:bg-yellow-50 border-yellow-300 text-yellow-700" onClick={fixPurchaseTotals}>
          <Wrench className="w-4 h-4" /> Виправити суми закупок
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

function GroupTabBtn({ id, group, setGroup, setTab, children }) {
  const active = group === id;
  function onClick() {
    setGroup(id);
    if (setTab) {
      if (id === 'buyer') setTab('purchases');
      else if (id === 'assembler') setTab('assembly');
      else if (id === 'inventory') setTab('inventory');
      else if (id === 'balance') setTab('balance');
      else if (id === 'products') setTab('products');
      else if (id === 'parts') setTab('parts');
      else if (id === 'assembly') setTab('assembly');
      else if (id === 'settings') setTab('settings');
    }
  }
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 rounded-xl flex items-center gap-2 border ${active ? "bg-gray-900 text-white" : "bg-white hover:bg-gray-50"}`}
    >
      {children}
    </button>
  );
}
